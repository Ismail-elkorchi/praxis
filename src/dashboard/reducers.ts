import { defaultProjectSettings, fullAccessPermissionProfileId } from "../core";
import type {
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
  Project,
  ProjectRuntimeState,
  Proposition,
  ProviderAvailability
} from "../core";
import type {
  AppSnapshot,
  ApprovalCardViewModel,
  CheckRunViewModel,
  DashboardAction,
  DashboardBadge,
  DashboardProjection,
  GlobalStatusViewModel,
  ProjectCardViewModel,
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
        runtimeState: "idle",
        git: emptyGitSnapshot,
        sessions: {},
        turns: {},
        approvals: [],
        commandRuns: [],
        fileChanges: [],
        checkDefinitions: payload.checkDefinitions ?? [],
        checkRuns: [],
        propositions: [],
        lastActivityAt: event.timestamp
      };
      break;
    }
    case "project.updated":
    case "project.archived": {
      const payload = event.payload as { project: ProjectSnapshot["project"] };
      const project = next.projects[payload.project.id];
      if (project) {
        project.project = normalizeProject(payload.project);
        project.lastActivityAt = event.timestamp;
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
      break;
    }
    case "agent.userInput.responded": {
      const project = touchProject(next, event);
      const session = project && event.sessionId ? project.sessions[event.sessionId] : undefined;
      if (session) {
        session.state = "active";
        session.updatedAt = event.timestamp;
      }
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
    case "check.cancelled": {
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
  if (project.git.conflictedFiles.length > 0) {
    return "blocked";
  }
  if (Object.values(project.sessions).some((session) => session.state === "failed")) {
    return "error";
  }
  if (project.approvals.some((approval) => approval.status === "pending")) {
    return "waiting_for_approval";
  }
  if (Object.values(project.sessions).some((session) => session.state === "waiting_for_user_input")) {
    return "waiting_for_user_input";
  }
  if (project.checkRuns.some((run) => run.status === "failed" && isRequiredCheck(project, run))) {
    return "checks_failed";
  }
  if (Object.values(project.turns).some((turn) => turn.status === "in_progress")) {
    return "agent_running";
  }
  if (hasReviewableChanges(project) && requiredChecksPassed(project)) {
    return "ready_for_review";
  }
  if (project.git.dirty || project.fileChanges.some((change) => change.status === "applied")) {
    return "dirty_worktree";
  }
  if (Object.values(project.sessions).some((session) => session.state === "idle" || session.state === "active")) {
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
  const mode = selectDashboardMode(visibleProjects, snapshot.activeTurns.length);
  const propositions = [
    ...Object.values(snapshot.projects).flatMap((project) => project.propositions),
    dashboardModeProposition(mode, projectCards)
  ];
  return {
    mode,
    globalStatus: globalStatus(snapshot),
    projectCards,
    approvals: approvalCards(snapshot),
    checkRuns: checkRunCards(snapshot),
    providerStatus: providerStatus(snapshot),
    timeline: timeline(snapshot),
    explanation: {
      mode,
      propositions,
      evidence: propositions.flatMap((proposition) => proposition.evidence)
    }
  };
}

function selectDashboardMode(projects: ProjectSnapshot[], activeTurnCount: number): DashboardMode {
  if (projects.some((project) => project.runtimeState === "unsafe_mode")) return "unsafe_attention";
  if (projects.some((project) => project.approvals.some((approval) => approval.status === "pending"))) return "approval_center";
  if (projects.some((project) => project.runtimeState === "checks_failed")) return "failure_triage";
  if (projects.some((project) => project.runtimeState === "ready_for_review" || project.runtimeState === "dirty_worktree")) {
    return "diff_review";
  }
  if (projects.some((project) => project.runtimeState === "stale")) return "stale_sessions";
  if (activeTurnCount > 0) return "active_work";
  return "portfolio";
}

function projectCard(project: ProjectSnapshot, snapshot: AppSnapshot): ProjectCardViewModel {
  const pendingApprovalCount = project.approvals.filter((approval) => approval.status === "pending").length;
  const failedCheckCount = project.checkRuns.filter((run) => run.status === "failed" && isRequiredCheck(project, run)).length;
  const activeTurnCount = Object.values(project.turns).filter((turn) => turn.status === "in_progress").length;
  const changedFileCount = new Set([
    ...project.fileChanges.map((change) => change.path),
    ...project.git.stagedFiles,
    ...project.git.unstagedFiles,
    ...project.git.untrackedFiles
  ]).size;
  const provider = Object.values(snapshot.providers)[0]?.provider;

  const evidence = projectEvidence(project);

  return {
    projectId: project.project.id,
    title: project.project.name,
    subtitle: project.project.rootPath,
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
    lastActivityAt: project.lastActivityAt,
    badges: badges(project),
    primaryAction: primaryAction(project, provider?.capabilities.canStartSession ?? false),
    secondaryActions: secondaryActions(project, evidence),
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
    failedCheckCount: projects.flatMap((project) => project.checkRuns).filter((run) => run.status === "failed").length,
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

function upsertApproval(items: ApprovalRequest[], item: ApprovalRequest): ApprovalRequest[] {
  return upsertById(items, item);
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
  return project.git.dirty || project.fileChanges.some((change) => change.status === "applied");
}

function requiredChecksPassed(project: ProjectSnapshot): boolean {
  const required = project.checkDefinitions.filter((definition) => definition.required);
  if (required.length === 0) return true;
  return required.every((definition) => {
    const latest = project.checkRuns
      .filter((run) => run.checkId === definition.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    return latest?.status === "passed";
  });
}

function isRequiredCheck(project: ProjectSnapshot, run: CheckRun): boolean {
  return project.checkDefinitions.some((definition) => definition.id === run.checkId && definition.required);
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
  if (project.checkRuns.some((run) => run.status === "failed" && isRequiredCheck(project, run))) {
    result.push({ label: "Required check failed", tone: "failed" });
  }
  if (project.git.dirty) result.push({ label: "Changed files", tone: "review" });
  return result;
}

function primaryAction(project: ProjectSnapshot, canStartSession: boolean): DashboardAction {
  if (project.approvals.some((approval) => approval.status === "pending")) {
    return { id: "open-approvals", label: "Open approvals", method: "agents.respondToApproval" };
  }
  if (project.runtimeState === "checks_failed") {
    return { id: "rerun-checks", label: "Rerun failed checks", method: "checks.run" };
  }
  if (project.runtimeState === "ready_for_review" || project.runtimeState === "dirty_worktree") {
    return { id: "review-diff", label: "Review diff", method: "git.openDiff" };
  }
  if (!canStartSession) {
    return {
      id: "start-task",
      label: "Start task",
      method: "agents.startSession",
      disabled: true,
      disabledReason: "Provider does not support starting sessions."
    };
  }
  return { id: "start-task", label: "Start task", method: "agents.startSession" };
}

function secondaryActions(project: ProjectSnapshot, evidence: EvidenceRef[]): DashboardAction[] {
  return [
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
  if (state === "agent_running" || state === "dirty_worktree" || state === "ready_for_review") return 2;
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
  if (state === "ready_for_review" || state === "dirty_worktree") return "review";
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
    scripts: [...(project.scripts ?? [])],
    metadataFiles: [...(project.metadataFiles ?? [])],
    worktrees: [...(project.worktrees ?? [])],
    settings: { ...defaultProjectSettings, ...project.settings }
  };
}
