import {
  agentRunId,
  projectArtifactId,
  projectSourceId,
  projectWorkItemId,
  type AgentRun,
  type AgentRunId,
  type AgentRunRolePreset,
  type ArtifactType,
  type EvidenceRef,
  type ProjectArtifact,
  type ProjectArtifactId,
  type ProjectId,
  type ProjectProfile,
  type ProjectSource,
  type ProjectSourceId,
  type ProjectWorkItem,
  type ProjectWorkItemId,
  type ProviderId,
  type SourceType,
  type WorkMode
} from "../core";
import type { AppSnapshot, HomeViewModel, ProjectWorkspaceViewModel } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";
import type { ProviderService } from "./ProviderService";
import { notFoundError, PraxisError } from "./errors";

type SnapshotProvider = () => AppSnapshot;

const now = () => new Date().toISOString();

export class ProjectWorkspaceService {
  constructor(
    private readonly events: AppEventLog,
    private readonly getSnapshot: SnapshotProvider
  ) {}

  getWorkspace(projectId: ProjectId): ProjectWorkspaceViewModel {
    const workspace = this.getSnapshot().dashboard.selectedWorkspace?.projectId === projectId
      ? this.getSnapshot().dashboard.selectedWorkspace
      : workspaceForProject(this.getSnapshot(), projectId);
    if (!workspace) throw notFoundError("Project workspace was not found.", { projectId });
    return workspace;
  }

  getHome(): HomeViewModel {
    return this.getSnapshot().dashboard.home;
  }

  getPortfolio() {
    return this.getSnapshot().dashboard.projectCards;
  }

  async addSource(input: {
    projectId: ProjectId;
    type: SourceType;
    title: string;
    uriOrPath?: string;
    contentRef?: string;
    addedBy?: ProjectSource["addedBy"];
    metadata?: Record<string, unknown>;
  }): Promise<ProjectSource> {
    requireProject(this.getSnapshot(), input.projectId);
    const timestamp = now();
    const source: ProjectSource = {
      id: projectSourceId(),
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      uriOrPath: input.uriOrPath,
      contentRef: input.contentRef,
      addedBy: input.addedBy ?? "user",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {}
    };
    await this.events.append(
      createDomainEvent({
        type: "project.source.added",
        projectId: input.projectId,
        source: input.addedBy === "agent" ? "agent" : "user",
        payload: { source },
        evidence: [{ type: "user", commandId: "projects.addSource" }]
      })
    );
    return source;
  }

  async removeSource(input: { projectId: ProjectId; sourceId: ProjectSourceId }): Promise<void> {
    const project = requireProject(this.getSnapshot(), input.projectId);
    if (!project.sources.some((source) => source.id === input.sourceId)) {
      throw notFoundError("Project source was not found.", { projectId: input.projectId, sourceId: input.sourceId });
    }
    await this.events.append(
      createDomainEvent({
        type: "project.source.removed",
        projectId: input.projectId,
        source: "user",
        payload: { sourceId: input.sourceId },
        evidence: [{ type: "user", commandId: "projects.removeSource" }]
      })
    );
  }
}

export class WorkItemService {
  constructor(
    private readonly events: AppEventLog,
    private readonly getSnapshot: SnapshotProvider
  ) {}

  async create(input: {
    projectId: ProjectId;
    title: string;
    goal: string;
    workModes?: WorkMode[];
    priority?: number;
    sourceIds?: ProjectSourceId[];
    metadata?: Record<string, unknown>;
  }): Promise<ProjectWorkItem> {
    const project = requireProject(this.getSnapshot(), input.projectId);
    validateSources(project, input.sourceIds ?? []);
    const timestamp = now();
    const workItem: ProjectWorkItem = {
      id: projectWorkItemId(),
      projectId: input.projectId,
      title: input.title,
      goal: input.goal,
      workModes: input.workModes && input.workModes.length > 0 ? unique(input.workModes) : [...project.profile.workModes],
      status: "planned",
      priority: input.priority ?? 3,
      sourceIds: [...(input.sourceIds ?? [])],
      artifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {}
    };
    await this.events.append(workItemEvent("project.workItem.created", workItem, "workItems.create"));
    return workItem;
  }

  async update(input: {
    projectId: ProjectId;
    workItemId: ProjectWorkItemId;
    patch: Partial<Pick<ProjectWorkItem, "title" | "goal" | "workModes" | "priority" | "sourceIds" | "artifactIds" | "metadata" | "status">>;
  }): Promise<ProjectWorkItem> {
    const existing = requireWorkItem(this.getSnapshot(), input.projectId, input.workItemId);
    const project = requireProject(this.getSnapshot(), input.projectId);
    validateSources(project, input.patch.sourceIds ?? existing.sourceIds);
    const workItem: ProjectWorkItem = {
      ...existing,
      ...input.patch,
      workModes: input.patch.workModes ? unique(input.patch.workModes) : existing.workModes,
      sourceIds: input.patch.sourceIds ? unique(input.patch.sourceIds) : existing.sourceIds,
      artifactIds: input.patch.artifactIds ? unique(input.patch.artifactIds) : existing.artifactIds,
      metadata: input.patch.metadata ?? existing.metadata,
      updatedAt: now()
    };
    await this.events.append(workItemEvent("project.workItem.updated", workItem, "workItems.update"));
    return workItem;
  }

  async queue(input: { projectId: ProjectId; workItemId: ProjectWorkItemId }): Promise<ProjectWorkItem> {
    return this.transition(input, "queued", "project.workItem.queued", "workItems.queue");
  }

  async cancel(input: { projectId: ProjectId; workItemId: ProjectWorkItemId }): Promise<ProjectWorkItem> {
    return this.transition(input, "cancelled", "project.workItem.cancelled", "workItems.cancel");
  }

  async complete(input: { projectId: ProjectId; workItemId: ProjectWorkItemId }): Promise<ProjectWorkItem> {
    return this.transition(input, "completed", "project.workItem.completed", "workItems.complete");
  }

  listByProject(projectId: ProjectId): ProjectWorkItem[] {
    return requireProject(this.getSnapshot(), projectId).workItems;
  }

  private async transition(
    input: { projectId: ProjectId; workItemId: ProjectWorkItemId },
    status: ProjectWorkItem["status"],
    type: string,
    commandId: string
  ): Promise<ProjectWorkItem> {
    const existing = requireWorkItem(this.getSnapshot(), input.projectId, input.workItemId);
    const workItem = { ...existing, status, updatedAt: now() };
    await this.events.append(workItemEvent(type, workItem, commandId));
    return workItem;
  }
}

export class ArtifactService {
  constructor(
    private readonly events: AppEventLog,
    private readonly getSnapshot: SnapshotProvider
  ) {}

  async create(input: {
    projectId: ProjectId;
    workItemId?: ProjectWorkItemId;
    agentRunId?: AgentRunId;
    type: ArtifactType;
    title: string;
    summary?: string;
    status?: ProjectArtifact["status"];
    contentRef?: string;
    sourceIds?: ProjectSourceId[];
    evidence?: EvidenceRef[];
    metadata?: Record<string, unknown>;
  }): Promise<ProjectArtifact> {
    const project = requireProject(this.getSnapshot(), input.projectId);
    if (input.workItemId) requireWorkItem(this.getSnapshot(), input.projectId, input.workItemId);
    if (input.agentRunId) requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    validateSources(project, input.sourceIds ?? []);
    const timestamp = now();
    const artifact: ProjectArtifact = {
      id: projectArtifactId(),
      projectId: input.projectId,
      workItemId: input.workItemId,
      agentRunId: input.agentRunId,
      type: input.type,
      title: input.title,
      summary: input.summary ?? "",
      status: input.status ?? "draft",
      contentRef: input.contentRef,
      sourceIds: [...(input.sourceIds ?? [])],
      evidence: input.evidence ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {}
    };
    await this.events.append(artifactEvent("project.artifact.created", artifact, "artifacts.create"));
    return artifact;
  }

  async update(input: {
    projectId: ProjectId;
    artifactId: ProjectArtifactId;
    patch: Partial<Pick<ProjectArtifact, "title" | "summary" | "status" | "contentRef" | "sourceIds" | "evidence" | "metadata">>;
  }): Promise<ProjectArtifact> {
    const existing = this.get(input);
    validateSources(requireProject(this.getSnapshot(), input.projectId), input.patch.sourceIds ?? existing.sourceIds);
    const artifact: ProjectArtifact = {
      ...existing,
      ...input.patch,
      sourceIds: input.patch.sourceIds ? unique(input.patch.sourceIds) : existing.sourceIds,
      evidence: input.patch.evidence ?? existing.evidence,
      metadata: input.patch.metadata ?? existing.metadata,
      updatedAt: now()
    };
    await this.events.append(artifactEvent("project.artifact.updated", artifact, "artifacts.update"));
    return artifact;
  }

  listByProject(projectId: ProjectId): ProjectArtifact[] {
    return requireProject(this.getSnapshot(), projectId).artifacts;
  }

  get(input: { projectId: ProjectId; artifactId: ProjectArtifactId }): ProjectArtifact {
    const artifact = requireProject(this.getSnapshot(), input.projectId).artifacts.find((item) => item.id === input.artifactId);
    if (!artifact) throw notFoundError("Project artifact was not found.", input);
    return artifact;
  }

  markReviewed(input: { projectId: ProjectId; artifactId: ProjectArtifactId }): Promise<ProjectArtifact> {
    return this.transition(input, "reviewed", "project.artifact.reviewed", "artifacts.markReviewed");
  }

  accept(input: { projectId: ProjectId; artifactId: ProjectArtifactId }): Promise<ProjectArtifact> {
    return this.transition(input, "accepted", "project.artifact.accepted", "artifacts.accept");
  }

  reject(input: { projectId: ProjectId; artifactId: ProjectArtifactId }): Promise<ProjectArtifact> {
    return this.transition(input, "rejected", "project.artifact.rejected", "artifacts.reject");
  }

  private async transition(
    input: { projectId: ProjectId; artifactId: ProjectArtifactId },
    status: ProjectArtifact["status"],
    type: string,
    commandId: string
  ): Promise<ProjectArtifact> {
    const artifact = { ...this.get(input), status, updatedAt: now() };
    await this.events.append(artifactEvent(type, artifact, commandId));
    return artifact;
  }
}

export class AgentRunService {
  constructor(
    private readonly events: AppEventLog,
    private readonly getSnapshot: SnapshotProvider,
    private readonly providers: ProviderService
  ) {}

  async create(input: {
    projectId: ProjectId;
    workItemId: ProjectWorkItemId;
    providerId: ProviderId;
    roleName: string;
    rolePreset?: AgentRunRolePreset;
    goal: string;
    cwd?: string;
    worktreePath?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRun> {
    requireWorkItem(this.getSnapshot(), input.projectId, input.workItemId);
    const timestamp = now();
    const run: AgentRun = {
      id: agentRunId(),
      projectId: input.projectId,
      workItemId: input.workItemId,
      providerId: input.providerId,
      roleName: input.roleName,
      rolePreset: input.rolePreset,
      goal: input.goal,
      status: "queued",
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      producedArtifactIds: [],
      pendingApprovalIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {}
    };
    await this.events.append(agentRunEvent("agent.run.created", run, "agentRuns.create"));
    return run;
  }

  async start(input: { projectId: ProjectId; agentRunId: AgentRunId; instruction?: string }): Promise<AgentRun> {
    const existing = requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    const workItem = requireWorkItem(this.getSnapshot(), input.projectId, existing.workItemId);
    const starting = { ...existing, status: "starting" as const, updatedAt: now() };
    await this.events.append(agentRunEvent("agent.run.started", starting, "agentRuns.start"));
    try {
      const sessionId = await this.providers.startSession({
        providerId: existing.providerId,
        projectId: existing.projectId,
        cwd: existing.cwd ?? this.getSnapshot().projects[existing.projectId]?.project.rootPath ?? ".",
        goal: existing.goal
      });
      const linked = { ...starting, status: "running" as const, sessionId, updatedAt: now() };
      await this.events.append(agentRunEvent("agent.run.linkedToSession", linked, "agentRuns.linkSession"));
      await this.providers.sendTurn({
        providerId: linked.providerId,
        projectId: linked.projectId,
        sessionId,
        instruction: input.instruction ?? workItem.goal
      });
      return this.get(input.projectId, input.agentRunId);
    } catch (error) {
      const failed = {
        ...starting,
        status: "failed" as const,
        metadata: { ...starting.metadata, error: error instanceof Error ? error.message : "Agent run failed." },
        updatedAt: now()
      };
      await this.events.append(agentRunEvent("agent.run.failed", failed, "agentRuns.start"));
      throw error;
    }
  }

  async stop(input: { projectId: ProjectId; agentRunId: AgentRunId; reason?: string }): Promise<AgentRun> {
    const run = requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    if (run.sessionId) {
      await this.providers.stopSession({ providerId: run.providerId, sessionId: run.sessionId, reason: input.reason ?? "Stopped by user." });
    }
    return this.transition(input, "cancelled", "agent.run.cancelled", "agentRuns.stop");
  }

  async cancel(input: { projectId: ProjectId; agentRunId: AgentRunId }): Promise<AgentRun> {
    return this.transition(input, "cancelled", "agent.run.cancelled", "agentRuns.cancel");
  }

  async sendInstruction(input: { projectId: ProjectId; agentRunId: AgentRunId; instruction: string }): Promise<AgentRun> {
    const run = requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    if (!run.sessionId) {
      throw new PraxisError("agent_run_not_started", "Agent run is not linked to a provider session.", { agentRunId: input.agentRunId });
    }
    await this.events.append(agentRunEvent("agent.run.statusChanged", { ...run, status: "running", updatedAt: now() }, "agentRuns.sendInstruction"));
    await this.providers.sendTurn({
      providerId: run.providerId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      instruction: input.instruction
    });
    return this.get(input.projectId, input.agentRunId);
  }

  async assignProvider(input: { projectId: ProjectId; agentRunId: AgentRunId; providerId: ProviderId }): Promise<AgentRun> {
    const run = requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    if (run.sessionId) {
      throw new PraxisError("agent_run_provider_locked", "Cannot change provider after a run is linked to a session.", {
        agentRunId: input.agentRunId
      });
    }
    return this.replaceRun({ ...run, providerId: input.providerId, updatedAt: now() }, "agent.run.statusChanged", "agentRuns.assignProvider");
  }

  async linkSession(input: { projectId: ProjectId; agentRunId: AgentRunId; sessionId: AgentRun["sessionId"] }): Promise<AgentRun> {
    const run = requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId);
    if (!input.sessionId) throw new PraxisError("invalid_agent_run_session", "A session id is required.", { agentRunId: input.agentRunId });
    const session = this.getSnapshot().projects[input.projectId]?.sessions[input.sessionId];
    if (!session) throw notFoundError("Provider session was not found.", { sessionId: input.sessionId });
    return this.replaceRun(
      { ...run, providerId: session.providerId, sessionId: input.sessionId, status: "running", updatedAt: now() },
      "agent.run.linkedToSession",
      "agentRuns.linkSession"
    );
  }

  listByProject(projectId: ProjectId): AgentRun[] {
    return requireProject(this.getSnapshot(), projectId).agentRuns;
  }

  listByWorkItem(input: { projectId: ProjectId; workItemId: ProjectWorkItemId }): AgentRun[] {
    requireWorkItem(this.getSnapshot(), input.projectId, input.workItemId);
    return this.listByProject(input.projectId).filter((run) => run.workItemId === input.workItemId);
  }

  private get(projectId: ProjectId, agentRunId: AgentRunId): AgentRun {
    return requireAgentRun(this.getSnapshot(), projectId, agentRunId);
  }

  private async transition(
    input: { projectId: ProjectId; agentRunId: AgentRunId },
    status: AgentRun["status"],
    type: string,
    commandId: string
  ): Promise<AgentRun> {
    const run = { ...requireAgentRun(this.getSnapshot(), input.projectId, input.agentRunId), status, updatedAt: now() };
    await this.events.append(agentRunEvent(type, run, commandId));
    return run;
  }

  private async replaceRun(run: AgentRun, type: string, commandId: string): Promise<AgentRun> {
    await this.events.append(agentRunEvent(type, run, commandId));
    return run;
  }
}

function workItemEvent(type: string, workItem: ProjectWorkItem, commandId: string) {
  return createDomainEvent({
    type,
    projectId: workItem.projectId,
    source: "user",
    payload: { workItem },
    evidence: [{ type: "user", commandId }]
  });
}

function artifactEvent(type: string, artifact: ProjectArtifact, commandId: string) {
  return createDomainEvent({
    type,
    projectId: artifact.projectId,
    source: "user",
    payload: { artifact },
    evidence: artifact.evidence.length > 0 ? artifact.evidence : [{ type: "user", commandId }]
  });
}

function agentRunEvent(type: string, agentRun: AgentRun, commandId: string) {
  return createDomainEvent({
    type,
    projectId: agentRun.projectId,
    sessionId: agentRun.sessionId,
    providerId: agentRun.providerId,
    source: "user",
    payload: { agentRun },
    evidence: [{ type: "user", commandId }]
  });
}

function requireProject(snapshot: AppSnapshot, projectId: ProjectId) {
  const project = snapshot.projects[projectId];
  if (!project) throw notFoundError("Project was not found.", { projectId });
  return project;
}

function requireWorkItem(snapshot: AppSnapshot, projectId: ProjectId, workItemId: ProjectWorkItemId): ProjectWorkItem {
  const item = requireProject(snapshot, projectId).workItems.find((candidate) => candidate.id === workItemId);
  if (!item) throw notFoundError("Project work item was not found.", { projectId, workItemId });
  return item;
}

function requireAgentRun(snapshot: AppSnapshot, projectId: ProjectId, agentRunId: AgentRunId): AgentRun {
  const run = requireProject(snapshot, projectId).agentRuns.find((candidate) => candidate.id === agentRunId);
  if (!run) throw notFoundError("Agent run was not found.", { projectId, agentRunId });
  return run;
}

function validateSources(project: ReturnType<typeof requireProject>, sourceIds: ProjectSourceId[]): void {
  const known = new Set(project.sources.map((source) => source.id));
  const missing = sourceIds.filter((sourceId) => !known.has(sourceId));
  if (missing.length > 0) {
    throw notFoundError("One or more project sources were not found.", { projectId: project.project.id, sourceIds: missing });
  }
}

function workspaceForProject(snapshot: AppSnapshot, projectId: ProjectId): ProjectWorkspaceViewModel | undefined {
  return snapshot.dashboard.selectedWorkspace?.projectId === projectId
    ? snapshot.dashboard.selectedWorkspace
    : buildWorkspaceFromSnapshot(snapshot, projectId);
}

function buildWorkspaceFromSnapshot(snapshot: AppSnapshot, projectId: ProjectId): ProjectWorkspaceViewModel | undefined {
  const project = snapshot.projects[projectId];
  if (!project) return undefined;
  const card = snapshot.dashboard.projectCards.find((item) => item.projectId === projectId);
  const providerName = (providerId: ProviderId) => snapshot.providers[providerId]?.provider.displayName ?? "Provider";
  const agentCards = project.agentRuns.map((run) => {
    const workItem = project.workItems.find((item) => item.id === run.workItemId);
    return {
      runId: run.id,
      projectId,
      workItemId: run.workItemId,
      roleName: run.roleName,
      rolePreset: run.rolePreset,
      providerLabel: providerName(run.providerId),
      providerId: run.providerId,
      linkedWorkItemTitle: workItem?.title ?? "Work item",
      status: run.status,
      lastEvent: run.lastEventId,
      pendingDecisionCount: run.pendingApprovalIds.length,
      pendingInput: run.status === "waiting_for_input",
      producedArtifactCount: run.producedArtifactIds.length,
      primaryAction:
        run.status === "queued"
          ? { id: "start-agent-run", label: "Start agent run", method: "agentRuns.start" }
          : { id: "open-agent-run", label: "Open details", method: "agentRuns.listByProject" },
      evidence: run.lastEventId ? [{ type: "event" as const, eventId: run.lastEventId }] : [{ type: "provider" as const, providerId: run.providerId }],
      advanced: {
        sessionId: run.sessionId,
        providerSessionExternalKind: run.sessionId ? project.sessions[run.sessionId]?.providerSessionRef?.externalKind : undefined
      }
    };
  });
  return {
    projectId,
    header: {
      name: project.project.name,
      profileFacets: card?.profileFacets ?? [
        ...(project.profile.userLabel ? [project.profile.userLabel] : []),
        ...project.profile.workModes,
        ...project.profile.sourceTypes,
        ...project.profile.expectedArtifactTypes,
        ...project.profile.customTags
      ],
      state: project.runtimeState,
      activeWorkCount: project.workItems.filter((item) => item.status !== "completed" && item.status !== "cancelled").length,
      runningAgentCount: project.agentRuns.filter((run) => run.status === "running" || run.status === "starting").length,
      pendingDecisionCount: project.approvals.filter((approval) => approval.status === "pending").length,
      latestArtifact: [...project.artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0],
      primaryAction: card?.primaryAction ?? { id: `open-workspace-${projectId}`, label: "Open workspace", method: "projects.getWorkspace" }
    },
    workItems: {
      current: project.workItems.filter((item) => ["running", "waiting_for_approval", "waiting_for_input", "reviewing"].includes(item.status)),
      queued: project.workItems.filter((item) => item.status === "planned" || item.status === "queued"),
      blocked: project.workItems.filter((item) => item.status === "blocked" || item.status === "failed"),
      completed: project.workItems.filter((item) => item.status === "completed" || item.status === "cancelled")
    },
    agentBoard: {
      queued: agentCards.filter((run) => run.status === "queued" || run.status === "starting"),
      running: agentCards.filter((run) => run.status === "running"),
      waiting: agentCards.filter((run) => run.status === "waiting_for_approval" || run.status === "waiting_for_input"),
      blocked: agentCards.filter((run) => run.status === "blocked" || run.status === "failed" || run.status === "stale"),
      review: agentCards.filter((run) => run.status === "reviewing"),
      done: agentCards.filter((run) => run.status === "completed" || run.status === "cancelled")
    },
    sources: project.sources.map((source) => ({
      ...source,
      usedByWorkItemIds: project.workItems.filter((item) => item.sourceIds.includes(source.id)).map((item) => item.id)
    })),
    artifacts: [...project.artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    decisions: snapshot.dashboard.approvals.filter((approval) => project.approvals.some((item) => item.id === approval.approvalId)),
    timeline: snapshot.dashboard.timeline.filter((item) => item.projectId === projectId)
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
