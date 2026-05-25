import { defaultProjectProfile, defaultProjectSettings, fullAccessPermissionProfileId } from "../core";
import type {
  AgentRun,
  AgentRunStatus,
  AgentProvider,
  AgentSession,
  AgentTurn,
  ApprovalDecision,
  ApprovalRequest,
  CheckDefinition,
  CheckRun,
  CommandRun,
  DashboardMode,
  DomainEvent,
  EvidenceRef,
  FileChange,
  GitSnapshot,
  ProjectArtifact,
  Project,
  ProjectProfile,
  ProjectRuntimeState,
  ProjectSource,
  ProjectWorkItem,
  Proposition,
  ProviderAvailability
} from "../core";
import { gitStatusHash } from "../git/statusHash";
import type {
  AppSnapshot,
  ApprovalCardViewModel,
  AgentRunCardViewModel,
  CheckRunViewModel,
  DashboardAction,
  DashboardBadge,
  DashboardProjection,
  GlobalStatusViewModel,
  HomeViewModel,
  ProjectCardViewModel,
  ProjectWorkspaceViewModel,
  ProjectSnapshot,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "./types";

const emptyGitSnapshot: GitSnapshot = {
  isRepo: false,
  dirty: false,
  ahead: 0,
  behind: 0,
  stagedFiles: [],
  unstagedFiles: [],
  untrackedFiles: [],
  conflictedFiles: []
};

export function emptySnapshot(): AppSnapshot {
  const snapshot: AppSnapshot = {
    projects: {},
    providers: {},
    focusedProjectId: undefined,
    approvals: { pending: [], history: [] },
    activeTurns: [],
    events: [],
    dashboard: emptyDashboard()
  };
  return rebuildDerived(snapshot);
}

export function replayEvents(events: DomainEvent[]): AppSnapshot {
  return events
    .slice()
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
    .reduce((snapshot, event) => reduceSnapshot(snapshot, event), emptySnapshot());
}

export function reduceSnapshot(snapshot: AppSnapshot, event: DomainEvent): AppSnapshot {
  const next = cloneSnapshot(snapshot);
  next.events = [...next.events, event];

  if (event.version !== 1) {
    return rebuildDerived(next);
  }

  switch (event.type) {
    case "project.registered": {
      const payload = event.payload as { project: ProjectSnapshot["project"]; checkDefinitions?: CheckDefinition[] };
      const project = normalizeProject(payload.project);
      next.projects[payload.project.id] = {
        project,
        profile: project.profile,
        sources: [],
        artifacts: [],
        workItems: [],
        agentRuns: [],
        runtimeState: "idle",
        git: emptyGitSnapshot,
        reviewState: { acceptedOutOfDateBranch: false, evidence: [] },
        sessions: {},
        turns: {},
        approvals: [],
        commandRuns: [],
        fileChanges: [],
        checkDefinitions: payload.checkDefinitions ?? [],
        checkRuns: [],
        propositions: [],
        timelineSummary: { eventCount: 0, latestEventTypes: [] },
        lastActivityAt: event.timestamp
      };
      break;
    }
    case "project.profile.updated": {
      const project = touchProject(next, event);
      const profile = normalizeProjectProfile((event.payload as { profile?: Partial<ProjectProfile> }).profile);
      if (project) {
        project.profile = profile;
        project.project.profile = profile;
      }
      break;
    }
    case "project.updated":
    case "project.archived": {
      const payload = event.payload as { project: ProjectSnapshot["project"] };
      const project = next.projects[payload.project.id];
      if (project) {
        project.project = normalizeProject(payload.project);
        project.profile = project.project.profile;
        project.lastActivityAt = event.timestamp;
        if (payload.project.archived && next.focusedProjectId === payload.project.id) {
          next.focusedProjectId = undefined;
        }
      }
      break;
    }
    case "project.source.added": {
      const project = touchProject(next, event);
      const source = (event.payload as { source?: ProjectSource }).source;
      if (project && source) {
        project.sources = upsertById(project.sources, source);
      }
      break;
    }
    case "project.source.removed": {
      const project = touchProject(next, event);
      const payload = event.payload as { sourceId?: ProjectSource["id"] };
      if (project && payload.sourceId) {
        project.sources = project.sources.filter((source) => source.id !== payload.sourceId);
        project.workItems = project.workItems.map((item) => ({
          ...item,
          sourceIds: item.sourceIds.filter((sourceId) => sourceId !== payload.sourceId)
        }));
        project.artifacts = project.artifacts.map((artifact) => ({
          ...artifact,
          sourceIds: artifact.sourceIds.filter((sourceId) => sourceId !== payload.sourceId)
        }));
      }
      break;
    }
    case "project.artifact.created":
    case "project.artifact.updated":
    case "project.artifact.reviewed":
    case "project.artifact.accepted":
    case "project.artifact.rejected": {
      const project = touchProject(next, event);
      const artifact = artifactFromEvent(event);
      if (project && artifact) {
        project.artifacts = upsertById(project.artifacts, artifact);
        if (artifact.workItemId) {
          project.workItems = project.workItems.map((item) =>
            item.id === artifact.workItemId && !item.artifactIds.includes(artifact.id)
              ? { ...item, artifactIds: [...item.artifactIds, artifact.id], updatedAt: event.timestamp }
              : item
          );
        }
        if (artifact.agentRunId) {
          project.agentRuns = project.agentRuns.map((run) =>
            run.id === artifact.agentRunId && !run.producedArtifactIds.includes(artifact.id)
              ? { ...run, producedArtifactIds: [...run.producedArtifactIds, artifact.id], updatedAt: event.timestamp }
              : run
          );
        }
      }
      break;
    }
    case "project.workItem.created":
    case "project.workItem.updated":
    case "project.workItem.queued":
    case "project.workItem.started":
    case "project.workItem.blocked":
    case "project.workItem.completed":
    case "project.workItem.cancelled":
    case "project.workItem.failed": {
      const project = touchProject(next, event);
      const workItem = workItemFromEvent(event);
      if (project && workItem) {
        project.workItems = upsertById(project.workItems, workItem);
      }
      break;
    }
    case "agent.run.created":
    case "agent.run.queued":
    case "agent.run.started":
    case "agent.run.linkedToSession":
    case "agent.run.statusChanged":
    case "agent.run.outputProduced":
    case "agent.run.blocked":
    case "agent.run.completed":
    case "agent.run.failed":
    case "agent.run.cancelled":
    case "agent.run.stale": {
      const project = touchProject(next, event);
      const run = agentRunFromEvent(project, event);
      if (project && run) {
        project.agentRuns = upsertById(project.agentRuns, run);
      }
      break;
    }
    case "dashboard.projectFocused": {
      const payload = event.payload as { projectId?: Project["id"] };
      if (payload.projectId && next.projects[payload.projectId] && !next.projects[payload.projectId].project.archived) {
        next.focusedProjectId = payload.projectId;
      }
      break;
    }
    case "dashboard.focusCleared": {
      next.focusedProjectId = undefined;
      break;
    }
    case "project.readyToMergeMarked": {
      const project = touchProject(next, event);
      const payload = event.payload as {
        markedAt?: string;
        acceptedOutOfDateBranch?: boolean;
        statusHash?: string;
      };
      if (project) {
        project.reviewState = {
          readyToMergeMarkedAt: payload.markedAt ?? event.timestamp,
          acceptedOutOfDateBranch: payload.acceptedOutOfDateBranch === true,
          statusHash: payload.statusHash,
          evidence: event.evidence
        };
      }
      break;
    }
    case "provider.registered":
    case "provider.available":
    case "provider.unavailable":
    case "provider.incompatible": {
      const provider = (event.payload as { provider?: AgentProvider }).provider;
      const availability = (event.payload as { availability?: ProviderAvailability }).availability;
      if (provider) {
        next.providers[provider.id] = {
          provider,
          lastCheckedAt: event.timestamp,
          issues: provider.availability.status === "available" ? [] : [provider.availability.reason ?? provider.availability.status]
        };
      } else if (event.providerId && next.providers[event.providerId] && availability) {
        next.providers[event.providerId].provider.availability = availability;
        next.providers[event.providerId].lastCheckedAt = event.timestamp;
        next.providers[event.providerId].issues =
          availability.status === "available" ? [] : [availability.reason ?? availability.status];
      }
      break;
    }
    case "provider.disabled": {
      if (event.providerId) {
        delete next.providers[event.providerId];
      }
      break;
    }
    case "provider.error": {
      if (event.providerId && next.providers[event.providerId]) {
        const message = String((event.payload as { message?: string }).message ?? "Provider error");
        next.providers[event.providerId].issues = [...next.providers[event.providerId].issues, message];
      }
      touchProject(next, event);
      break;
    }
    case "agent.session.started": {
      const project = event.projectId ? next.projects[event.projectId] : undefined;
      if (project && event.sessionId && event.providerId) {
        const payload = event.payload as Partial<AgentSession>;
        const session: AgentSession = {
          id: event.sessionId,
          projectId: project.project.id,
          providerId: event.providerId,
          providerSessionRef: payload.providerSessionRef,
          cwd: payload.cwd ?? project.project.rootPath,
          state: "active",
          goal: payload.goal,
          createdAt: event.timestamp,
          updatedAt: event.timestamp
        };
        project.sessions[event.sessionId] = session;
        project.lastActivityAt = event.timestamp;
        updateAgentRunsBySession(project, event.sessionId, event, (run) => ({ ...run, status: "running" }));
      }
      break;
    }
    case "agent.session.resumed": {
      const project = touchProject(next, event);
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state = "active";
        session.updatedAt = event.timestamp;
      }
      updateAgentRunsBySession(project, event.sessionId, event, (run) => ({ ...run, status: "running" }));
      break;
    }
    case "agent.session.stale":
    case "agent.session.failed":
    case "agent.session.stopped": {
      const project = touchProject(next, event);
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state =
          event.type === "agent.session.stale"
            ? "stale_or_disconnected"
            : event.type === "agent.session.failed"
              ? "failed"
              : "stopped";
        session.updatedAt = event.timestamp;
      } else if (project && event.type === "agent.session.failed" && event.sessionId && event.providerId) {
        project.sessions[event.sessionId] = {
          id: event.sessionId,
          projectId: project.project.id,
          providerId: event.providerId,
          cwd: project.project.rootPath,
          state: "failed",
          createdAt: event.timestamp,
          updatedAt: event.timestamp
        };
      }
      updateAgentRunsBySession(project, event.sessionId, event, (run) => ({
        ...run,
        status:
          event.type === "agent.session.stale"
            ? "stale"
            : event.type === "agent.session.failed"
              ? "failed"
              : run.status === "completed"
                ? run.status
                : "cancelled"
      }));
      break;
    }
    case "agent.turn.started": {
      const project = touchProject(next, event);
      if (project && event.sessionId && event.turnId && event.providerId) {
        const turn: AgentTurn = {
          id: event.turnId,
          sessionId: event.sessionId,
          projectId: project.project.id,
          providerId: event.providerId,
          status: "in_progress",
          inputSummary: String((event.payload as { inputSummary?: string }).inputSummary ?? "Agent turn"),
          startedAt: event.timestamp
        };
        project.turns[event.turnId] = turn;
        const session = project.sessions[event.sessionId];
        if (session) {
          session.state = "active";
          session.activeTurnId = event.turnId;
          session.updatedAt = event.timestamp;
        }
        updateAgentRunsBySession(project, event.sessionId, event, (run) => ({ ...run, status: "running" }));
      }
      break;
    }
    case "agent.turn.completed":
    case "agent.turn.failed":
    case "agent.turn.interrupted": {
      const project = touchProject(next, event);
      const turn = project && event.turnId ? project.turns[event.turnId] : undefined;
      if (turn) {
        turn.status =
          event.type === "agent.turn.completed" ? "completed" : event.type === "agent.turn.failed" ? "failed" : "interrupted";
        turn.completedAt = event.timestamp;
      }
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state = event.type === "agent.turn.failed" ? "failed" : "idle";
        session.activeTurnId = undefined;
        session.updatedAt = event.timestamp;
      }
      updateAgentRunsBySession(project, event.sessionId, event, (run) => ({
        ...run,
        status:
          event.type === "agent.turn.completed"
            ? "completed"
            : event.type === "agent.turn.failed"
              ? "failed"
              : "cancelled"
      }));
      break;
    }
    case "agent.command.started":
    case "agent.command.output":
    case "agent.command.completed":
    case "agent.command.failed":
    case "agent.command.cancelled": {
      const project = touchProject(next, event);
      if (project) {
        project.commandRuns = reduceCommandRuns(project, event);
      }
      break;
    }
    case "agent.userInput.requested": {
      const project = touchProject(next, event);
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state = "waiting_for_user_input";
        session.updatedAt = event.timestamp;
      }
      updateAgentRunsBySession(project, event.sessionId, event, (run) => ({ ...run, status: "waiting_for_input" }));
      break;
    }
    case "agent.userInput.responded": {
      const project = touchProject(next, event);
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state = "active";
        session.updatedAt = event.timestamp;
      }
      updateAgentRunsBySession(project, event.sessionId, event, (run) => ({ ...run, status: "running" }));
      break;
    }
    case "approval.requested": {
      const project = touchProject(next, event);
      const approval = event.payload as ApprovalRequest;
      if (project) {
        project.approvals = upsertApproval(project.approvals, approval);
        const session = project.sessions[approval.sessionId];
        if (session) {
          session.state = "waiting_for_approval";
          session.updatedAt = event.timestamp;
        }
        updateAgentRunsBySession(project, approval.sessionId, event, (run) => ({
          ...run,
          status: "waiting_for_approval",
          pendingApprovalIds: run.pendingApprovalIds.includes(approval.id)
            ? run.pendingApprovalIds
            : [...run.pendingApprovalIds, approval.id]
        }));
      }
      break;
    }
    case "approval.accepted":
    case "approval.declined":
    case "approval.cancelled":
    case "approval.expired": {
      const project = touchProject(next, event);
      const payload = event.payload as { approvalId: ApprovalRequest["id"]; decision?: ApprovalDecision; resolvedAt?: string };
      if (project && approvalResolutionIsAuthoritative(event)) {
        project.approvals = project.approvals.map((approval) =>
          approval.id === payload.approvalId
            ? {
                ...approval,
                status: approvalStatusFromEvent(event.type),
                decision: payload.decision,
                resolvedAt: payload.resolvedAt ?? event.timestamp
              }
            : approval
        );
        updateAgentRunsByApproval(project, payload.approvalId, event, (run) => ({
          ...run,
          status: run.status === "waiting_for_approval" ? "running" : run.status,
          pendingApprovalIds: run.pendingApprovalIds.filter((approvalId) => approvalId !== payload.approvalId)
        }));
      }
      break;
    }
    case "agent.fileChange.proposed":
    case "agent.fileChange.applied":
    case "agent.fileChange.rejected": {
      const project = touchProject(next, event);
      const fileChange = event.payload as FileChange;
      if (project) {
        project.fileChanges = upsertById(project.fileChanges, fileChange);
      }
      break;
    }
    case "git.statusChanged": {
      const project = touchProject(next, event);
      if (project) {
        project.git = event.payload as GitSnapshot;
      }
      break;
    }
    case "git.worktree.created": {
      const project = touchProject(next, event);
      const payload = event.payload as { path?: string; branch?: string; headSha?: string };
      if (project && payload.path) {
        project.project.worktrees = upsertByPath(project.project.worktrees, {
          path: payload.path,
          branch: payload.branch,
          headSha: payload.headSha
        });
      }
      break;
    }
    case "check.definitionDetected": {
      const project = touchProject(next, event);
      const definitions = (event.payload as { checkDefinitions: CheckDefinition[] }).checkDefinitions;
      if (project) {
        project.checkDefinitions = definitions;
      }
      break;
    }
    case "check.started":
    case "check.completed":
    case "check.failed":
    case "check.cancelled":
    case "check.waived": {
      const project = touchProject(next, event);
      const checkRun = event.payload as CheckRun;
      if (project) {
        project.checkRuns = upsertById(project.checkRuns, checkRun);
      }
      break;
    }
    default:
      break;
  }

  return rebuildDerived(next);
}

function rebuildDerived(snapshot: AppSnapshot): AppSnapshot {
  for (const project of Object.values(snapshot.projects)) {
    project.timelineSummary = projectTimelineSummary(project, snapshot.events);
    project.runtimeState = deriveProjectRuntimeState(project);
    project.propositions = deriveProjectPropositions(project, snapshot.events);
  }

  const approvals = Object.values(snapshot.projects).flatMap((project) => project.approvals);
  snapshot.approvals = {
    pending: approvals.filter((approval) => approval.status === "pending"),
    history: approvals.filter((approval) => approval.status !== "pending")
  };
  snapshot.activeTurns = Object.values(snapshot.projects)
    .flatMap((project) => Object.values(project.turns))
    .filter((turn) => turn.status === "in_progress");
  snapshot.dashboard = buildDashboard(snapshot);
  return snapshot;
}

function deriveProjectRuntimeState(project: ProjectSnapshot): ProjectRuntimeState {
  if (project.project.settings.defaultPermissionProfileId === fullAccessPermissionProfileId) {
    return "unsafe_mode";
  }
  if (project.approvals.some((approval) => approval.status === "pending" && requiresUnsafeAttention(approval))) {
    return "unsafe_mode";
  }
  if (Object.values(project.sessions).some((session) => session.state === "stale_or_disconnected")) {
    return "stale";
  }
  if (project.agentRuns.some((run) => run.status === "stale")) {
    return "stale";
  }
  if (project.git.conflictedFiles.length > 0) {
    return "blocked";
  }
  if (project.workItems.some((item) => item.status === "blocked") || project.agentRuns.some((run) => run.status === "blocked")) {
    return "blocked";
  }
  if (Object.values(project.sessions).some((session) => session.state === "failed")) {
    return "error";
  }
  if (project.agentRuns.some((run) => run.status === "failed") || project.workItems.some((item) => item.status === "failed")) {
    return "error";
  }
  if (project.approvals.some((approval) => approval.status === "pending")) {
    return "waiting_for_approval";
  }
  if (project.agentRuns.some((run) => run.status === "waiting_for_approval")) {
    return "waiting_for_approval";
  }
  if (Object.values(project.sessions).some((session) => session.state === "waiting_for_user_input")) {
    return "waiting_for_user_input";
  }
  if (project.agentRuns.some((run) => run.status === "waiting_for_input")) {
    return "waiting_for_user_input";
  }
  if (hasFailedRequiredCheck(project)) {
    return "checks_failed";
  }
  if (project.workItems.some((item) => item.status === "reviewing") || project.agentRuns.some((run) => run.status === "reviewing")) {
    return "reviewing_diff";
  }
  if (Object.values(project.turns).some((turn) => turn.status === "in_progress")) {
    return "agent_running";
  }
  if (project.workItems.some((item) => item.status === "running") || project.agentRuns.some((run) => run.status === "running" || run.status === "starting")) {
    return "agent_running";
  }
  if (isReadyToMerge(project)) {
    return "ready_to_merge";
  }
  if (hasReviewableChanges(project) && requiredChecksPassed(project)) {
    return "ready_for_review";
  }
  if (project.git.isRepo && project.git.dirty) {
    return "dirty_worktree";
  }
  if (Object.values(project.sessions).some((session) => session.state === "idle" || session.state === "active")) {
    return "agent_ready";
  }
  if (project.workItems.some((item) => item.status === "queued") || project.agentRuns.some((run) => run.status === "queued")) {
    return "agent_ready";
  }
  return "idle";
}

function deriveProjectPropositions(project: ProjectSnapshot, events: DomainEvent[]): Proposition[] {
  const checkedAt = project.lastActivityAt ?? project.project.updatedAt;
  const evidence = projectEvidence(project, events);
  return [
    {
      id: `project:${project.project.id}:pending-approval`,
      subject: project.project.id,
      predicate: "has_pending_approval",
      value: project.approvals.some((approval) => approval.status === "pending") ? "true" : "false",
      evidence,
      checkedAt
    },
    {
      id: `project:${project.project.id}:required-checks-green`,
      subject: project.project.id,
      predicate: "required_checks_green",
      value: requiredChecksPassed(project) ? "true" : "false",
      evidence,
      checkedAt
    },
    {
      id: `project:${project.project.id}:ready-for-review`,
      subject: project.project.id,
      predicate: "ready_for_review",
      value: project.runtimeState === "ready_for_review" ? "true" : "false",
      evidence,
      checkedAt
    },
    {
      id: `project:${project.project.id}:ready-to-merge`,
      subject: project.project.id,
      predicate: "ready_to_merge",
      value: project.runtimeState === "ready_to_merge" ? "true" : "false",
      evidence,
      checkedAt
    },
    {
      id: `project:${project.project.id}:unsafe-attention`,
      subject: project.project.id,
      predicate: "requires_unsafe_attention",
      value: project.runtimeState === "unsafe_mode" ? "true" : "false",
      evidence,
      checkedAt
    }
  ];
}

function buildDashboard(snapshot: AppSnapshot): DashboardProjection {
  const visibleProjects = Object.values(snapshot.projects).filter(
    (project) => !project.project.archived && project.project.settings.showInDashboard
  );
  const projectCards = visibleProjects.map((project) => projectCard(project, snapshot));
  const mode = selectDashboardMode(visibleProjects, snapshot.activeTurns.length, snapshot.focusedProjectId);
  const allTimeline = timeline(snapshot);
  const propositions = [
    ...Object.values(snapshot.projects).flatMap((project) => project.propositions),
    dashboardModeProposition(mode, projectCards)
  ];
  return {
    mode,
    focusedProjectId: snapshot.focusedProjectId,
    home: homeView(snapshot, projectCards, allTimeline),
    selectedWorkspace: snapshot.focusedProjectId ? projectWorkspace(snapshot, snapshot.focusedProjectId, projectCards, allTimeline) : undefined,
    globalStatus: globalStatus(snapshot),
    projectCards,
    approvals: approvalCards(snapshot),
    checkRuns: checkRunCards(snapshot),
    providerStatus: providerStatus(snapshot),
    timeline: allTimeline,
    explanation: {
      mode,
      propositions,
      evidence: propositions.flatMap((proposition) => proposition.evidence)
    }
  };
}

function selectDashboardMode(
  projects: ProjectSnapshot[],
  activeTurnCount: number,
  focusedProjectId: Project["id"] | undefined
): DashboardMode {
  if (projects.some((project) => project.runtimeState === "unsafe_mode")) return "unsafe_attention";
  if (projects.some((project) => project.approvals.some((approval) => approval.status === "pending"))) return "approval_center";
  if (projects.some((project) => project.runtimeState === "checks_failed")) return "failure_triage";
  if (
    projects.some(
      (project) =>
        project.runtimeState === "ready_to_merge" ||
        project.runtimeState === "ready_for_review" ||
        project.runtimeState === "dirty_worktree"
    )
  ) {
    return "diff_review";
  }
  if (projects.some((project) => project.runtimeState === "stale")) return "stale_sessions";
  if (activeTurnCount > 1) return "active_work";
  if (projects.some((project) => project.runtimeState === "agent_planning")) return "planning";
  if (focusedProjectId && projects.some((project) => project.project.id === focusedProjectId)) return "single_project_focus";
  return "portfolio";
}

function projectCard(project: ProjectSnapshot, snapshot: AppSnapshot): ProjectCardViewModel {
  const pendingApprovalCount = project.approvals.filter((approval) => approval.status === "pending").length;
  const failedCheckCount = failedRequiredCheckCount(project);
  const activeTurnCount = Object.values(project.turns).filter((turn) => turn.status === "in_progress").length;
  const currentWorkItem = currentProjectWorkItem(project);
  const latestArtifact = latestProjectArtifact(project);
  const activeAgentCount = project.agentRuns.filter((run) => run.status === "running" || run.status === "starting").length;
  const waitingAgentCount = project.agentRuns.filter(
    (run) => run.status === "waiting_for_approval" || run.status === "waiting_for_input"
  ).length;
  const blockedAgentCount = project.agentRuns.filter((run) => run.status === "blocked" || run.status === "stale" || run.status === "failed").length;
  const changedFileCount = new Set([
    ...project.fileChanges.map((change) => change.path),
    ...project.git.stagedFiles,
    ...project.git.unstagedFiles,
    ...project.git.untrackedFiles
  ]).size;
  const provider =
    (project.project.settings.defaultProviderId ? snapshot.providers[project.project.settings.defaultProviderId]?.provider : undefined) ??
    Object.values(snapshot.providers)[0]?.provider;

  const evidence = projectEvidence(project, snapshot.events);

  return {
    projectId: project.project.id,
    title: project.project.name,
    subtitle: project.project.rootPath,
    profileFacets: profileFacets(project.profile),
    runtimeState: project.runtimeState,
    urgency: urgency(project.runtimeState),
    stateLabel: stateLabel(project.runtimeState),
    stateReason: stateReason(project, changedFileCount, pendingApprovalCount, failedCheckCount),
    providerLabel: provider?.displayName,
    branchLabel: project.git.branch,
    changedFileCount,
    pendingApprovalCount,
    failedCheckCount,
    activeTurnCount,
    currentWorkItemTitle: currentWorkItem?.title,
    activeAgentCount,
    waitingAgentCount,
    blockedAgentCount,
    latestArtifactTitle: latestArtifact?.title,
    reviewCheckStatus: reviewCheckStatus(project),
    lastActivityAt: project.lastActivityAt,
    badges: badges(project),
    primaryAction: openWorkspaceAction(project.project.id),
    secondaryActions: secondaryActions(project, evidence, provider),
    diffFiles: diffFiles(project),
    evidence
  };
}

function approvalCards(snapshot: AppSnapshot): ApprovalCardViewModel[] {
  return snapshot.approvals.pending.map((approval) => {
    const project = snapshot.projects[approval.projectId];
    const provider = snapshot.providers[approval.providerId]?.provider;
    const allowSessionApproval =
      provider?.capabilities.supportsPermissionProfiles === true &&
      approval.kind !== "permission_escalation" &&
      approval.risk !== "critical";
    return {
      approvalId: approval.id,
      providerId: approval.providerId,
      sessionId: approval.sessionId,
      workItemId: project?.agentRuns.find((run) => run.pendingApprovalIds.includes(approval.id))?.workItemId,
      agentRunId: project?.agentRuns.find((run) => run.pendingApprovalIds.includes(approval.id))?.id,
      projectTitle: project?.project.name ?? "Project",
      providerLabel: provider?.displayName ?? "Provider",
      kind: approval.kind,
      risk: approval.risk,
      riskSignals: approval.riskSignals,
      title: approval.title,
      summary: approval.description,
      requestedAt: approval.createdAt,
      decisionOptions: [
        { decision: "accept_once", label: "Accept once", requiresConfirmation: approval.risk === "critical" },
        ...(allowSessionApproval
          ? [{ decision: "accept_for_session" as const, label: "Accept for session", requiresConfirmation: approval.risk !== "low" }]
          : []),
        { decision: "decline", label: "Decline", requiresConfirmation: false },
        { decision: "cancel", label: "Cancel", requiresConfirmation: false }
      ],
      evidence: approval.evidence
    };
  });
}

function checkRunCards(snapshot: AppSnapshot): CheckRunViewModel[] {
  return Object.values(snapshot.projects)
    .flatMap((project) =>
      project.checkRuns.map((run) => {
        const definition = project.checkDefinitions.find((check) => check.id === run.checkId);
        return {
          runId: run.id,
          checkId: run.checkId,
          projectId: run.projectId,
          projectTitle: project.project.name,
          name: definition?.name ?? "Check",
          command: definition?.command ?? [],
          status: run.status,
          required: definition?.required ?? false,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: durationMs(run.startedAt, run.completedAt),
          exitCode: run.exitCode,
          output: run.outputSummary ?? run.stderrRef ?? run.stdoutRef ?? "",
          relatedFiles: run.relatedFiles,
          evidence: [{ type: "check" as const, runId: run.id, status: run.status }]
        };
      })
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function providerStatus(snapshot: AppSnapshot): ProviderStatusViewModel[] {
  return Object.values(snapshot.providers).map(({ provider }) => ({
    providerId: provider.id,
    name: provider.displayName,
    availability: provider.availability,
    capabilities: provider.capabilities,
    adapterVersion: provider.adapterVersion
  }));
}

function homeView(snapshot: AppSnapshot, projectCards: ProjectCardViewModel[], allTimeline: TimelineItemViewModel[]): HomeViewModel {
  const projects = Object.values(snapshot.projects).filter((project) => !project.project.archived);
  const runningAgents = projects.flatMap((project) => agentRunCards(project, snapshot)).filter((run) => run.status === "running" || run.status === "starting");
  const blockedWork = projects.flatMap((project) => [
    ...project.workItems
      .filter((item) => item.status === "blocked" || item.status === "failed")
      .map((item) => ({
        id: item.id,
        projectId: project.project.id,
        title: item.title,
        summary: item.status === "failed" ? "Work item failed." : "Work item is blocked.",
        action: openWorkspaceAction(project.project.id),
        timestamp: item.updatedAt
      })),
    ...project.agentRuns
      .filter((run) => run.status === "blocked" || run.status === "failed" || run.status === "stale")
      .map((run) => ({
        id: run.id,
        projectId: project.project.id,
        title: run.roleName,
        summary: run.status === "stale" ? "Agent run is stale." : run.status === "failed" ? "Agent run failed." : "Agent run is blocked.",
        action: openWorkspaceAction(project.project.id),
        timestamp: run.updatedAt
      }))
  ]);
  const recentArtifacts = projects
    .flatMap((project) => project.artifacts)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);

  return {
    workInbox: [
      ...snapshot.approvals.pending.map((approval) => ({
        id: approval.id,
        projectId: approval.projectId,
        title: approval.title,
        summary: approval.description,
        action: { id: "open-decision-center", label: "Open decision center", method: "agents.respondToApproval" },
        timestamp: approval.createdAt
      })),
      ...projects.flatMap((project) =>
        project.workItems
          .filter((item) => item.status === "planned" || item.status === "queued")
          .map((item) => ({
            id: item.id,
            projectId: project.project.id,
            title: item.title,
            summary: item.goal,
            action: openWorkspaceAction(project.project.id),
            timestamp: item.updatedAt
          }))
      )
    ].slice(0, 12),
    activeProjects: projectCards.filter((card) => card.runtimeState !== "idle").slice(0, 8),
    waitingDecisions: approvalCards(snapshot),
    runningAgents,
    blockedWork: blockedWork.slice(0, 8),
    readyToReview: projectCards.filter((card) => card.runtimeState === "ready_for_review" || card.runtimeState === "ready_to_merge"),
    recentArtifacts,
    quickCreate: [
      { id: "create-project", label: "Create project", method: "projects.register" },
      { id: "add-source", label: "Add source", method: "projects.addSource" },
      { id: "create-work-item", label: "Create work item", method: "workItems.create" },
      { id: "start-agent-run", label: "Start agent run", method: "agentRuns.start" },
      { id: "create-artifact", label: "Create artifact", method: "artifacts.create" },
      { id: "open-decisions", label: "Open decision center", method: "agents.respondToApproval" }
    ],
    questions: [
      "What needs my decision?",
      "What is running?",
      "What is blocked?",
      "What produced something new?",
      "Which project should I open next?",
      "What can I start now?"
    ]
  };
}

function projectWorkspace(
  snapshot: AppSnapshot,
  projectId: Project["id"],
  projectCards: ProjectCardViewModel[],
  allTimeline: TimelineItemViewModel[]
): ProjectWorkspaceViewModel | undefined {
  const project = snapshot.projects[projectId];
  if (!project) return undefined;
  const card = projectCards.find((item) => item.projectId === projectId) ?? projectCard(project, snapshot);
  const latestArtifact = latestProjectArtifact(project);
  const runs = agentRunCards(project, snapshot);
  return {
    projectId,
    header: {
      name: project.project.name,
      profileFacets: profileFacets(project.profile),
      state: project.runtimeState,
      activeWorkCount: project.workItems.filter((item) => ["queued", "running", "waiting_for_approval", "waiting_for_input", "blocked", "reviewing"].includes(item.status)).length,
      runningAgentCount: project.agentRuns.filter((run) => run.status === "running" || run.status === "starting").length,
      pendingDecisionCount: project.approvals.filter((approval) => approval.status === "pending").length,
      latestArtifact,
      primaryAction: workspacePrimaryAction(project, card)
    },
    workItems: {
      current: project.workItems.filter((item) => item.status === "running" || item.status === "waiting_for_approval" || item.status === "waiting_for_input" || item.status === "reviewing"),
      queued: project.workItems.filter((item) => item.status === "planned" || item.status === "queued"),
      blocked: project.workItems.filter((item) => item.status === "blocked" || item.status === "failed"),
      completed: project.workItems.filter((item) => item.status === "completed" || item.status === "cancelled")
    },
    agentBoard: {
      queued: runs.filter((run) => run.status === "queued" || run.status === "starting"),
      running: runs.filter((run) => run.status === "running"),
      waiting: runs.filter((run) => run.status === "waiting_for_approval" || run.status === "waiting_for_input"),
      blocked: runs.filter((run) => run.status === "blocked" || run.status === "failed" || run.status === "stale"),
      review: runs.filter((run) => run.status === "reviewing"),
      done: runs.filter((run) => run.status === "completed" || run.status === "cancelled")
    },
    sources: project.sources.map((source) => ({
      ...source,
      usedByWorkItemIds: project.workItems.filter((item) => item.sourceIds.includes(source.id)).map((item) => item.id)
    })),
    artifacts: [...project.artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    decisions: approvalCards(snapshot).filter((approval) => project.approvals.some((item) => item.id === approval.approvalId)),
    timeline: allTimeline.filter((item) => item.projectId === projectId)
  };
}

function agentRunCards(project: ProjectSnapshot, snapshot: AppSnapshot): AgentRunCardViewModel[] {
  return project.agentRuns.map((run) => {
    const provider = snapshot.providers[run.providerId]?.provider;
    const workItem = project.workItems.find((item) => item.id === run.workItemId);
    const session = run.sessionId ? project.sessions[run.sessionId] : undefined;
    const pendingDecisionCount = run.pendingApprovalIds.filter((approvalId) =>
      project.approvals.some((approval) => approval.id === approvalId && approval.status === "pending")
    ).length;
    return {
      runId: run.id,
      projectId: run.projectId,
      workItemId: run.workItemId,
      roleName: run.roleName,
      rolePreset: run.rolePreset,
      providerLabel: provider?.displayName ?? "Provider",
      providerId: run.providerId,
      linkedWorkItemTitle: workItem?.title ?? "Work item",
      status: run.status,
      lastEvent: run.lastEventId,
      pendingDecisionCount,
      pendingInput: run.status === "waiting_for_input",
      producedArtifactCount: run.producedArtifactIds.length,
      primaryAction: agentRunPrimaryAction(run),
      evidence: run.lastEventId ? [{ type: "event", eventId: run.lastEventId }] : [{ type: "provider", providerId: run.providerId }],
      advanced: {
        sessionId: run.sessionId,
        providerSessionExternalKind: session?.providerSessionRef?.externalKind
      }
    };
  });
}

function workspacePrimaryAction(project: ProjectSnapshot, card: ProjectCardViewModel): DashboardAction {
  if (project.approvals.some((approval) => approval.status === "pending")) {
    return { id: "open-decisions", label: "Open decisions", method: "agents.respondToApproval" };
  }
  const queuedRun = project.agentRuns.find((run) => run.status === "queued");
  if (queuedRun) {
    return { id: "start-agent-run", label: "Start agent run", method: "agentRuns.start" };
  }
  const activeRun = project.agentRuns.find((run) =>
    run.status === "running" || run.status === "waiting_for_approval" || run.status === "waiting_for_input"
  );
  if (activeRun) {
    return { id: "send-instruction", label: "Send instruction", method: "agentRuns.sendInstruction" };
  }
  if (
    card.diffFiles.length > 0 &&
    (project.runtimeState === "ready_for_review" || project.runtimeState === "ready_to_merge" || project.runtimeState === "dirty_worktree")
  ) {
    return { id: "open-diff", label: "Review diff", method: "git.openDiff" };
  }
  if (project.workItems.length > 0 && Object.values(project.turns).some((turn) => turn.status === "in_progress")) {
    return { id: "create-artifact", label: "Create artifact", method: "artifacts.create" };
  }
  return { id: "create-work-item", label: "Create work item", method: "workItems.create" };
}

function agentRunPrimaryAction(run: AgentRun): DashboardAction {
  if (run.status === "queued") return { id: "start-agent-run", label: "Start agent run", method: "agentRuns.start" };
  if (run.status === "running" || run.status === "waiting_for_approval" || run.status === "waiting_for_input") {
    return { id: "send-instruction", label: "Send instruction", method: "agentRuns.sendInstruction" };
  }
  if (run.status === "blocked" || run.status === "stale" || run.status === "failed") {
    return { id: "cancel-agent-run", label: "Cancel run", method: "agentRuns.cancel" };
  }
  return { id: "open-agent-run", label: "Open details", method: "agentRuns.listByProject" };
}

function durationMs(start: string, end: string | undefined): number | undefined {
  if (!end) return undefined;
  const startedAt = Date.parse(start);
  const endedAt = Date.parse(end);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
  return Math.max(0, endedAt - startedAt);
}

function timeline(snapshot: AppSnapshot): TimelineItemViewModel[] {
  return snapshot.events
    .filter((event) => event.type !== "provider.rawEvent")
    .slice(-80)
    .reverse()
    .map((event) => ({
      id: event.id,
      kind: timelineKind(event.type),
      eventType: event.type,
      projectId: event.projectId,
      providerId: event.providerId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      title: event.type,
      summary: summarizePayload(event.payload),
      timestamp: event.timestamp,
      status: event.type.split(".").at(-1),
      evidence: event.evidence.length > 0 ? event.evidence : [{ type: "event", eventId: event.id }],
      expandable: true
    }));
}

function globalStatus(snapshot: AppSnapshot): GlobalStatusViewModel {
  const projects = Object.values(snapshot.projects);
  return {
    activeProjectCount: projects.filter((project) => project.runtimeState !== "idle").length,
    activeTurnCount: snapshot.activeTurns.length,
    pendingApprovalCount: snapshot.approvals.pending.length,
    failedCheckCount: projects.reduce((count, project) => count + failedRequiredCheckCount(project), 0),
    staleSessionCount: projects.flatMap((project) => Object.values(project.sessions)).filter((session) => session.state === "stale_or_disconnected").length,
    unsafeStateCount: projects.filter((project) => project.runtimeState === "unsafe_mode").length,
    providerIssues: Object.values(snapshot.providers).flatMap((provider) =>
      provider.issues.map((message) => ({ providerId: provider.provider.id, message }))
    )
  };
}

function dashboardModeProposition(mode: DashboardMode, projectCards: ProjectCardViewModel[]): Proposition {
  return {
    id: `dashboard:mode:${mode}`,
    subject: "dashboard",
    predicate: "selected_mode",
    value: "true",
    evidence: projectCards.flatMap((card) => card.evidence),
    checkedAt: new Date(0).toISOString()
  };
}

function touchProject(snapshot: AppSnapshot, event: DomainEvent): ProjectSnapshot | undefined {
  if (!event.projectId) return undefined;
  const project = snapshot.projects[event.projectId];
  if (project) {
    project.lastActivityAt = event.timestamp;
  }
  return project;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing) => (existing.id === item.id ? item : existing));
}

function upsertByPath<T extends { path: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.path === item.path);
  if (index === -1) return [...items, item];
  return items.map((existing) => (existing.path === item.path ? item : existing));
}

function upsertApproval(items: ApprovalRequest[], item: ApprovalRequest): ApprovalRequest[] {
  return upsertById(items, item);
}

function updateAgentRunsBySession(
  project: ProjectSnapshot | undefined,
  sessionId: DomainEvent["sessionId"],
  event: DomainEvent,
  update: (run: AgentRun) => AgentRun
): void {
  if (!project || !sessionId) return;
  project.agentRuns = project.agentRuns.map((run) =>
    run.sessionId === sessionId ? withRunEventMetadata(update(run), event) : run
  );
}

function updateAgentRunsByApproval(
  project: ProjectSnapshot | undefined,
  approvalId: ApprovalRequest["id"],
  event: DomainEvent,
  update: (run: AgentRun) => AgentRun
): void {
  if (!project) return;
  project.agentRuns = project.agentRuns.map((run) =>
    run.pendingApprovalIds.includes(approvalId) ? withRunEventMetadata(update(run), event) : run
  );
}

function withRunEventMetadata(run: AgentRun, event: DomainEvent): AgentRun {
  return {
    ...run,
    lastEventId: event.id,
    updatedAt: event.timestamp
  };
}

function artifactFromEvent(event: DomainEvent): ProjectArtifact | undefined {
  const payload = objectPayload(event.payload);
  const artifact = objectPayload(payload.artifact) as Partial<ProjectArtifact> | undefined;
  const candidate = artifact?.id ? artifact : (payload as Partial<ProjectArtifact>);
  if (!candidate?.id || !event.projectId) return undefined;
  return {
    id: candidate.id,
    projectId: candidate.projectId ?? event.projectId,
    workItemId: candidate.workItemId,
    agentRunId: candidate.agentRunId,
    type: candidate.type ?? "generic_file",
    title: candidate.title ?? "Artifact",
    summary: candidate.summary ?? "",
    status: artifactStatusFromEvent(event.type, candidate.status),
    contentRef: candidate.contentRef,
    sourceIds: [...(candidate.sourceIds ?? [])],
    evidence: candidate.evidence ?? event.evidence,
    createdAt: candidate.createdAt ?? event.timestamp,
    updatedAt: candidate.updatedAt ?? event.timestamp,
    metadata: candidate.metadata ?? {}
  };
}

function workItemFromEvent(event: DomainEvent): ProjectWorkItem | undefined {
  const payload = objectPayload(event.payload);
  const workItem = objectPayload(payload.workItem) as Partial<ProjectWorkItem> | undefined;
  const candidate = workItem?.id ? workItem : (payload as Partial<ProjectWorkItem>);
  if (!candidate?.id || !event.projectId) return undefined;
  return {
    id: candidate.id,
    projectId: candidate.projectId ?? event.projectId,
    title: candidate.title ?? "Work item",
    goal: candidate.goal ?? "",
    workModes: [...(candidate.workModes ?? ["custom"])],
    status: workItemStatusFromEvent(event.type, candidate.status),
    priority: candidate.priority ?? 3,
    sourceIds: [...(candidate.sourceIds ?? [])],
    artifactIds: [...(candidate.artifactIds ?? [])],
    createdAt: candidate.createdAt ?? event.timestamp,
    updatedAt: candidate.updatedAt ?? event.timestamp,
    metadata: candidate.metadata ?? {}
  };
}

function agentRunFromEvent(project: ProjectSnapshot | undefined, event: DomainEvent): AgentRun | undefined {
  const payload = objectPayload(event.payload);
  const agentRun = (objectPayload(payload.agentRun) as Partial<AgentRun>) ?? undefined;
  const candidate = agentRun?.id ? agentRun : (payload as Partial<AgentRun>);
  const existing = project?.agentRuns.find((run) => run.id === candidate.id);
  if (!candidate?.id || !event.projectId || !event.providerId) return undefined;
  const workItemId = candidate.workItemId ?? existing?.workItemId;
  if (!workItemId) return undefined;
  return {
    id: candidate.id,
    projectId: candidate.projectId ?? event.projectId,
    workItemId,
    providerId: candidate.providerId ?? event.providerId,
    sessionId: candidate.sessionId ?? existing?.sessionId ?? event.sessionId,
    roleName: candidate.roleName ?? existing?.roleName ?? "Agent",
    rolePreset: candidate.rolePreset ?? existing?.rolePreset,
    goal: candidate.goal ?? existing?.goal ?? "",
    status: agentRunStatusFromEvent(event.type, candidate.status ?? existing?.status),
    cwd: candidate.cwd ?? existing?.cwd,
    worktreePath: candidate.worktreePath ?? existing?.worktreePath,
    lastEventId: candidate.lastEventId ?? event.id,
    producedArtifactIds: [...(candidate.producedArtifactIds ?? existing?.producedArtifactIds ?? [])],
    pendingApprovalIds: [...(candidate.pendingApprovalIds ?? existing?.pendingApprovalIds ?? [])],
    createdAt: candidate.createdAt ?? existing?.createdAt ?? event.timestamp,
    updatedAt: candidate.updatedAt ?? event.timestamp,
    metadata: candidate.metadata ?? existing?.metadata ?? {}
  };
}

function artifactStatusFromEvent(type: string, fallback: ProjectArtifact["status"] | undefined): ProjectArtifact["status"] {
  if (type === "project.artifact.reviewed") return "reviewed";
  if (type === "project.artifact.accepted") return "accepted";
  if (type === "project.artifact.rejected") return "rejected";
  return fallback ?? "draft";
}

function workItemStatusFromEvent(type: string, fallback: ProjectWorkItem["status"] | undefined): ProjectWorkItem["status"] {
  if (type === "project.workItem.queued") return "queued";
  if (type === "project.workItem.started") return "running";
  if (type === "project.workItem.blocked") return "blocked";
  if (type === "project.workItem.completed") return "completed";
  if (type === "project.workItem.cancelled") return "cancelled";
  if (type === "project.workItem.failed") return "failed";
  return fallback ?? "planned";
}

function agentRunStatusFromEvent(type: string, fallback: AgentRunStatus | undefined): AgentRunStatus {
  if (type === "agent.run.queued") return "queued";
  if (type === "agent.run.started") return "running";
  if (type === "agent.run.blocked") return "blocked";
  if (type === "agent.run.completed") return "completed";
  if (type === "agent.run.failed") return "failed";
  if (type === "agent.run.cancelled") return "cancelled";
  if (type === "agent.run.stale") return "stale";
  return fallback ?? "queued";
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function reduceCommandRuns(project: ProjectSnapshot, event: DomainEvent): CommandRun[] {
  const payload = event.payload as Partial<CommandRun>;
  const existing = findCommandRun(project.commandRuns, payload.id, event.turnId);
  const id = payload.id ?? existing?.id;
  if (!id) return project.commandRuns;

  const commandRun: CommandRun = {
    id,
    projectId: project.project.id,
    sessionId: payload.sessionId ?? event.sessionId ?? existing?.sessionId,
    turnId: payload.turnId ?? event.turnId ?? existing?.turnId,
    command: payload.command ?? existing?.command ?? [],
    cwd: payload.cwd ?? existing?.cwd ?? project.project.rootPath,
    status: commandStatusFromEvent(event.type, payload.status ?? existing?.status),
    exitCode: payload.exitCode ?? existing?.exitCode,
    startedAt: payload.startedAt ?? existing?.startedAt ?? event.timestamp,
    completedAt: payload.completedAt ?? commandCompletedAt(event.type, event.timestamp, existing?.completedAt),
    stdoutRef: payload.stdoutRef ?? existing?.stdoutRef,
    stderrRef: payload.stderrRef ?? existing?.stderrRef
  };

  return upsertById(project.commandRuns, commandRun);
}

function findCommandRun(commandRuns: CommandRun[], id: CommandRun["id"] | undefined, turnId: DomainEvent["turnId"]): CommandRun | undefined {
  if (id) return commandRuns.find((run) => run.id === id);
  if (!turnId) return undefined;
  return commandRuns
    .filter((run) => run.turnId === turnId && (run.status === "requested" || run.status === "running"))
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))[0];
}

function commandStatusFromEvent(type: string, fallback: CommandRun["status"] | undefined): CommandRun["status"] {
  if (type === "agent.command.started") return "running";
  if (type === "agent.command.completed") return "completed";
  if (type === "agent.command.failed") return "failed";
  if (type === "agent.command.cancelled") return "cancelled";
  return fallback ?? "running";
}

function commandCompletedAt(type: string, timestamp: string, fallback: string | undefined): string | undefined {
  if (type === "agent.command.completed" || type === "agent.command.failed" || type === "agent.command.cancelled") {
    return timestamp;
  }
  return fallback;
}

function approvalStatusFromEvent(type: string): ApprovalRequest["status"] {
  if (type === "approval.accepted") return "accepted";
  if (type === "approval.declined") return "declined";
  if (type === "approval.cancelled") return "cancelled";
  return "expired";
}

function approvalResolutionIsAuthoritative(event: DomainEvent): boolean {
  if (event.source === "user") return true;
  if (event.source === "system" && (event.type === "approval.cancelled" || event.type === "approval.expired")) return true;
  return false;
}

function hasReviewableChanges(project: ProjectSnapshot): boolean {
  return project.git.isRepo && project.git.dirty;
}

function isReadyToMerge(project: ProjectSnapshot): boolean {
  return (
    hasReviewableChanges(project) &&
    requiredChecksPassed(project) &&
    project.git.conflictedFiles.length === 0 &&
    (project.git.behind === 0 || project.reviewState.acceptedOutOfDateBranch) &&
    project.reviewState.readyToMergeMarkedAt !== undefined &&
    project.reviewState.statusHash === gitStatusHash(project.git)
  );
}

function requiredChecksPassed(project: ProjectSnapshot): boolean {
  const required = project.checkDefinitions.filter((definition) => definition.required);
  if (required.length === 0) return true;
  return required.every((definition) => {
    const latest = project.checkRuns
      .filter((run) => run.checkId === definition.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    return latest?.status === "passed" || latest?.status === "waived";
  });
}

function hasFailedRequiredCheck(project: ProjectSnapshot): boolean {
  return failedRequiredCheckCount(project) > 0;
}

function failedRequiredCheckCount(project: ProjectSnapshot): number {
  return project.checkDefinitions.filter((definition) => {
    if (!definition.required) return false;
    const latest = project.checkRuns
      .filter((run) => run.checkId === definition.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    return latest?.status === "failed";
  }).length;
}

function requiresUnsafeAttention(approval: ApprovalRequest): boolean {
  return (
    isUnsafeRisk(approval.risk) ||
    approval.riskSignals.includes("writes_outside_workspace") ||
    approval.riskSignals.includes("uses_full_access")
  );
}

function isUnsafeRisk(risk: ApprovalRequest["risk"]): boolean {
  return risk === "critical" || risk === "unknown";
}

function projectEvidence(project: ProjectSnapshot, events: DomainEvent[] = []): EvidenceRef[] {
  const eventEvidence = events
    .filter((event) => event.projectId === project.project.id)
    .slice(-8)
    .map((event) => ({ type: "event" as const, eventId: event.id }));
  const approvalEvidence = project.approvals.flatMap((approval) => approval.evidence);
  const fileEvidence = project.fileChanges.flatMap((change) => change.evidence);
  const checkEvidence = project.checkRuns.map((run) => ({ type: "check" as const, runId: run.id, status: run.status }));
  return [...eventEvidence, ...approvalEvidence, ...fileEvidence, ...checkEvidence].slice(0, 12);
}

function projectTimelineSummary(project: ProjectSnapshot, events: DomainEvent[]): ProjectSnapshot["timelineSummary"] {
  const projectEvents = events.filter((event) => event.projectId === project.project.id);
  return {
    lastEventAt: projectEvents.at(-1)?.timestamp,
    eventCount: projectEvents.length,
    latestEventTypes: projectEvents
      .slice(-8)
      .reverse()
      .map((event) => event.type)
  };
}

function normalizeProjectProfile(profile: Partial<ProjectProfile> | undefined): ProjectProfile {
  return {
    userLabel: profile?.userLabel,
    workModes: uniqueNonEmpty(profile?.workModes, defaultProjectProfile.workModes),
    sourceTypes: uniqueNonEmpty(profile?.sourceTypes, defaultProjectProfile.sourceTypes),
    expectedArtifactTypes: uniqueNonEmpty(profile?.expectedArtifactTypes, defaultProjectProfile.expectedArtifactTypes),
    riskProfile: profile?.riskProfile
      ? {
          ...profile.riskProfile,
          signals: [...(profile.riskProfile.signals ?? [])]
        }
      : undefined,
    customTags: [...(profile?.customTags ?? [])],
    customMetadata: profile?.customMetadata
  };
}

function uniqueNonEmpty<T extends string>(values: readonly T[] | undefined, fallback: readonly T[]): T[] {
  const normalized = [...new Set((values && values.length > 0 ? values : fallback).filter(Boolean))] as T[];
  return normalized.length > 0 ? normalized : [...fallback];
}

function profileFacets(profile: ProjectProfile): string[] {
  return [
    ...(profile.userLabel ? [profile.userLabel] : []),
    ...profile.workModes,
    ...profile.sourceTypes,
    ...profile.expectedArtifactTypes,
    ...profile.customTags
  ].slice(0, 10);
}

function currentProjectWorkItem(project: ProjectSnapshot): ProjectWorkItem | undefined {
  return [...project.workItems]
    .sort((left, right) => {
      const statusDelta = workItemRank(left.status) - workItemRank(right.status);
      if (statusDelta !== 0) return statusDelta;
      const priorityDelta = left.priority - right.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return right.updatedAt.localeCompare(left.updatedAt);
    })[0];
}

function workItemRank(status: ProjectWorkItem["status"]): number {
  if (status === "running" || status === "waiting_for_approval" || status === "waiting_for_input") return 0;
  if (status === "blocked" || status === "failed") return 1;
  if (status === "reviewing") return 2;
  if (status === "queued") return 3;
  if (status === "planned") return 4;
  return 5;
}

function latestProjectArtifact(project: ProjectSnapshot): ProjectArtifact | undefined {
  return [...project.artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function reviewCheckStatus(project: ProjectSnapshot): string | undefined {
  if (project.checkDefinitions.length === 0 && !project.git.isRepo) return undefined;
  if (hasFailedRequiredCheck(project)) return "Required check failed";
  if (project.runtimeState === "ready_to_merge") return "Reviewed and ready";
  if (project.runtimeState === "ready_for_review") return "Ready to review";
  if (project.checkDefinitions.length > 0 && requiredChecksPassed(project)) return "Checks passed";
  if (project.git.dirty) return "Changes pending";
  return undefined;
}

function openWorkspaceAction(projectId: Project["id"]): DashboardAction {
  return { id: `open-workspace-${projectId}`, label: "Open workspace", method: "projects.getWorkspace" };
}

function badges(project: ProjectSnapshot): DashboardBadge[] {
  const result: DashboardBadge[] = [{ label: stateLabel(project.runtimeState), tone: badgeTone(project.runtimeState) }];
  if (project.approvals.some((approval) => approval.status === "pending")) result.push({ label: "Approval pending", tone: "waiting" });
  if (
    project.approvals.some(
      (approval) => approval.status === "pending" && approval.riskSignals.includes("writes_outside_workspace")
    )
  ) {
    result.push({ label: "Outside workspace", tone: "unsafe" });
  }
  if (hasFailedRequiredCheck(project)) {
    result.push({ label: "Required check failed", tone: "failed" });
  }
  if (project.git.dirty) result.push({ label: "Changed files", tone: "review" });
  return result;
}

function primaryAction(project: ProjectSnapshot, provider: AgentProvider | undefined): DashboardAction {
  const capabilities = provider?.capabilities;
  const providerAvailable = provider?.availability.status === "available";
  if (project.approvals.some((approval) => approval.status === "pending")) {
    return { id: "open-approvals", label: "Open approvals", method: "agents.respondToApproval" };
  }
  if (project.runtimeState === "stale") {
    if (providerAvailable && capabilities?.canResumeSession) {
      return { id: "resume-session", label: "Resume session", method: "agents.resumeSession" };
    }
    if (providerAvailable && capabilities?.canStartSession) {
      return { id: "recover-session", label: "Start recovery task", method: "agents.startSession" };
    }
    return {
      id: "recover-session",
      label: "Start recovery task",
      method: "agents.startSession",
      disabled: true,
      disabledReason: provider ? "Provider is not currently available." : "Provider does not support recovery actions."
    };
  }
  if (project.runtimeState === "checks_failed") {
    return { id: "rerun-checks", label: "Rerun failed checks", method: "checks.run" };
  }
  if (project.runtimeState === "ready_for_review") {
    return { id: "mark-reviewed", label: "Mark reviewed", method: "projects.markReadyToMerge" };
  }
  if (project.runtimeState === "ready_to_merge" || project.runtimeState === "dirty_worktree") {
    return { id: "review-diff", label: "Review diff", method: "git.openDiff" };
  }
  if (!providerAvailable || !capabilities?.canStartSession) {
    return {
      id: "start-task",
      label: "Start task",
      method: "agents.startSession",
      disabled: true,
      disabledReason: providerAvailable ? "Provider does not support starting sessions." : "Provider is not currently available."
    };
  }
  return { id: "start-task", label: "Start task", method: "agents.startSession" };
}

function secondaryActions(project: ProjectSnapshot, evidence: EvidenceRef[], provider: AgentProvider | undefined): DashboardAction[] {
  const capabilities = provider?.capabilities;
  const providerAvailable = provider?.availability.status === "available";
  return [
    primaryAction(project, provider),
    ...(project.runtimeState === "stale" ? [{ id: "stop-session", label: "Stop session", method: "agents.stopSession" }] : []),
    ...(providerAvailable && capabilities?.canImportExistingSessions
      ? [{ id: "import-sessions", label: "Import sessions", method: "agents.importSessions" }]
      : []),
    { id: "run-checks", label: "Run checks", method: "checks.run" },
    ...(evidence.length > 0 ? [{ id: "open-evidence", label: "Open evidence", method: "dashboard.explainMode" }] : []),
    ...(project.git.isRepo ? [{ id: "open-diff", label: "Open diff review", method: "git.openDiff" }] : [])
  ];
}

function diffFiles(project: ProjectSnapshot): ProjectCardViewModel["diffFiles"] {
  const fromProvider = project.fileChanges.map((change) => ({
    path: change.path,
    changeKind: change.changeKind,
    source: "provider" as const,
    sourceSessionId: change.sessionId,
    sourceTurnId: change.turnId,
    binary: false,
    summary: change.diffRef ?? `${change.changeKind} file change`,
    evidence: change.evidence
  }));
  const knownPaths = new Set(fromProvider.map((change) => change.path));
  const gitEvidence: EvidenceRef[] = [{ type: "git", repoPath: project.project.rootPath, sha: project.git.headSha }];
  const fromGit = [
    ...project.git.stagedFiles,
    ...project.git.unstagedFiles,
    ...project.git.untrackedFiles
  ]
    .filter((file, index, files) => !knownPaths.has(file) && files.indexOf(file) === index)
    .map((file) => ({
      path: file,
      changeKind: project.git.untrackedFiles.includes(file) ? ("created" as const) : ("modified" as const),
      source: "git" as const,
      binary: false,
      summary: project.git.untrackedFiles.includes(file) ? "Untracked file" : "Git working tree change",
      evidence: gitEvidence
    }));

  return [...fromProvider, ...fromGit].sort((left, right) => left.path.localeCompare(right.path));
}

function urgency(state: ProjectRuntimeState): 0 | 1 | 2 | 3 | 4 | 5 {
  if (state === "unsafe_mode") return 5;
  if (state === "waiting_for_approval" || state === "waiting_for_user_input" || state === "blocked") return 4;
  if (state === "checks_failed" || state === "stale") return 3;
  if (state === "agent_running" || state === "dirty_worktree" || state === "ready_for_review" || state === "ready_to_merge") {
    return 2;
  }
  if (state === "agent_ready") return 1;
  return 0;
}

function stateLabel(state: ProjectRuntimeState): string {
  return state
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function stateReason(project: ProjectSnapshot, changedFiles: number, approvals: number, failedChecks: number): string {
  if (project.runtimeState === "waiting_for_approval") return `${approvals} approval request needs a decision.`;
  if (project.runtimeState === "waiting_for_user_input") return "A session is waiting for user input.";
  if (project.runtimeState === "checks_failed") return `${failedChecks} required check failed.`;
  if (project.runtimeState === "ready_for_review") return `${changedFiles} changed file(s) are ready for review.`;
  if (project.runtimeState === "ready_to_merge") return `${changedFiles} changed file(s) are reviewed and ready to merge.`;
  if (project.runtimeState === "stale") return "A session is stale or disconnected.";
  if (project.project.settings.defaultPermissionProfileId === fullAccessPermissionProfileId) {
    return "A broad permission profile requires attention.";
  }
  if (
    project.approvals.some(
      (approval) => approval.status === "pending" && approval.riskSignals.includes("writes_outside_workspace")
    )
  ) {
    return "A file change outside the project root requires attention.";
  }
  if (project.approvals.some((approval) => approval.status === "pending" && approval.riskSignals.includes("uses_full_access"))) {
    return "A full-access request requires attention.";
  }
  if (project.runtimeState === "unsafe_mode") return "A high-risk or unknown-risk request needs attention.";
  if (project.runtimeState === "agent_running") return "An agent turn is in progress.";
  if (project.git.dirty) return `${changedFiles} changed file(s) detected.`;
  return "No urgent state detected.";
}

function badgeTone(state: ProjectRuntimeState): DashboardBadge["tone"] {
  if (state === "unsafe_mode") return "unsafe";
  if (state === "waiting_for_approval" || state === "waiting_for_user_input") return "waiting";
  if (state === "checks_failed") return "failed";
  if (state === "blocked") return "blocked";
  if (state === "stale") return "stale";
  if (state === "ready_to_merge" || state === "ready_for_review" || state === "dirty_worktree") return "review";
  if (state === "agent_running" || state === "agent_ready") return "active";
  return "idle";
}

function timelineKind(type: string): TimelineItemViewModel["kind"] {
  if (type.startsWith("agent.turn")) return "turn";
  if (type.startsWith("agent.command")) return "command";
  if (type.startsWith("agent.userInput")) return "message";
  if (type.startsWith("agent.fileChange")) return "file_change";
  if (type.startsWith("approval")) return "approval";
  if (type.startsWith("check")) return "check";
  if (type === "provider.error") return "provider_error";
  return "system";
}

function summarizePayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if ("title" in payload && typeof payload.title === "string") return payload.title;
  if ("inputSummary" in payload && typeof payload.inputSummary === "string") return payload.inputSummary;
  if ("message" in payload && typeof payload.message === "string") return payload.message;
  return undefined;
}

function cloneSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return structuredClone(snapshot) as AppSnapshot;
}

function emptyDashboard(): DashboardProjection {
  return {
    mode: "portfolio",
    focusedProjectId: undefined,
    home: emptyHome(),
    selectedWorkspace: undefined,
    globalStatus: {
      activeProjectCount: 0,
      activeTurnCount: 0,
      pendingApprovalCount: 0,
      failedCheckCount: 0,
      staleSessionCount: 0,
      unsafeStateCount: 0,
      providerIssues: []
    },
    projectCards: [],
    approvals: [],
    checkRuns: [],
    providerStatus: [],
    timeline: [],
    explanation: { mode: "portfolio", propositions: [], evidence: [] }
  };
}

function normalizeProject(project: Project): Project {
  return {
    ...project,
    profile: normalizeProjectProfile(project.profile),
    scripts: [...(project.scripts ?? [])],
    metadataFiles: [...(project.metadataFiles ?? [])],
    worktrees: [...(project.worktrees ?? [])],
    settings: { ...defaultProjectSettings, ...project.settings }
  };
}

function emptyHome(): HomeViewModel {
  return {
    workInbox: [],
    activeProjects: [],
    waitingDecisions: [],
    runningAgents: [],
    blockedWork: [],
    readyToReview: [],
    recentArtifacts: [],
    quickCreate: [
      { id: "create-project", label: "Create project", method: "projects.register" },
      { id: "create-work-item", label: "Create work item", method: "workItems.create" },
      { id: "open-decisions", label: "Open decision center", method: "agents.respondToApproval" }
    ],
    questions: [
      "What needs my decision?",
      "What is running?",
      "What is blocked?",
      "What produced something new?",
      "Which project should I open next?",
      "What can I start now?"
    ]
  };
}
