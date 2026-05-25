import { performance } from "node:perf_hooks";
import type {
  AgentSessionId,
  AgentTurnId,
  AgentRunId,
  ProjectArtifactId,
  ProjectSourceId,
  ProjectWorkItemId,
  CheckDefinitionId,
  ApprovalDecision,
  ApprovalRequestId,
  CheckRunId,
  ProjectId,
  ProjectProfile,
  ProjectSettings,
  ProviderId
} from "../core";
import { createDomainEvent } from "../events/eventFactory";
import type { EventQuery } from "../events/EventStore";
import { gitStatusHash } from "../git/statusHash";
import type { AppSettings } from "../settings/SettingsService";
import type { PraxisRuntime } from "./PraxisApp";
import { PraxisError } from "./errors";

export type ClientRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type ApiError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  evidence?: unknown[];
};

export type ServerResponse = { id: string; result: unknown } | { id: string; error: ApiError };

export const apiMethods = [
  "projects.list",
  "projects.register",
  "projects.update",
  "projects.archive",
  "projects.refresh",
  "projects.markReadyToMerge",
  "projects.getWorkspace",
  "projects.updateProfile",
  "projects.addSource",
  "projects.removeSource",
  "projects.getHome",
  "projects.getPortfolio",
  "workItems.create",
  "workItems.update",
  "workItems.queue",
  "workItems.cancel",
  "workItems.complete",
  "workItems.listByProject",
  "agentRuns.create",
  "agentRuns.start",
  "agentRuns.stop",
  "agentRuns.cancel",
  "agentRuns.sendInstruction",
  "agentRuns.assignProvider",
  "agentRuns.linkSession",
  "agentRuns.listByProject",
  "agentRuns.listByWorkItem",
  "artifacts.create",
  "artifacts.update",
  "artifacts.listByProject",
  "artifacts.get",
  "artifacts.markReviewed",
  "artifacts.accept",
  "artifacts.reject",
  "providers.list",
  "providers.getStatus",
  "providers.getCapabilities",
  "providers.checkAvailability",
  "agents.startSession",
  "agents.resumeSession",
  "agents.stopSession",
  "agents.sendTurn",
  "agents.steerTurn",
  "agents.interruptTurn",
  "agents.respondToApproval",
  "agents.respondToUserInput",
  "agents.readSession",
  "agents.listSessions",
  "agents.importSessions",
  "dashboard.getSnapshot",
  "dashboard.subscribe",
  "dashboard.explainMode",
  "dashboard.focusProject",
  "dashboard.clearFocus",
  "diagnostics.get",
  "settings.get",
  "settings.update",
  "checks.list",
  "checks.run",
  "checks.cancel",
  "checks.waive",
  "git.getStatus",
  "git.openDiff",
  "git.createWorktree",
  "git.discardChanges",
  "events.replay",
  "events.query"
] as const;

export type ApiMethod = (typeof apiMethods)[number];

export class PraxisApi {
  constructor(private readonly app: PraxisRuntime) {}

  async handle(request: ClientRequest): Promise<ServerResponse> {
    const snapshotStarted = isDashboardSnapshotRequest(request.method) ? performance.now() : undefined;
    let ok = false;
    try {
      const result = await this.dispatch(request.method as ApiMethod, request.params);
      ok = true;
      return { id: request.id, result };
    } catch (error) {
      return { id: request.id, error: toApiError(error) };
    } finally {
      if (snapshotStarted !== undefined) {
        this.app.observability.recordDashboardSnapshotGeneration({
          method: request.method,
          durationMs: performance.now() - snapshotStarted,
          ok
        });
      }
    }
  }

  private async dispatch(method: ApiMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "projects.list":
        return this.app.projects.listProjects();
      case "projects.register": {
        const input = params as { rootPath: string; name?: string; defaultProviderId?: ProviderId; profile?: Partial<ProjectProfile> };
        return this.app.projects.registerProject(input);
      }
      case "projects.update": {
        const input = params as {
          projectId: ProjectId;
          patch: { name?: string; tags?: string[]; archived?: boolean; settings?: Partial<ProjectSettings>; profile?: Partial<ProjectProfile> };
          confirmBroadPermissionProfile?: boolean;
        };
        return this.app.projects.updateProject(input.projectId, input.patch, {
          confirmBroadPermissionProfile: input.confirmBroadPermissionProfile
        });
      }
      case "projects.archive": {
        const input = params as { projectId: ProjectId };
        return this.app.projects.archiveProject(input.projectId);
      }
      case "projects.refresh": {
        const input = params as { projectId?: ProjectId };
        if (input?.projectId) {
          await this.app.projects.refreshProject(input.projectId);
        }
        return this.app.snapshot().dashboard.projectCards;
      }
      case "projects.markReadyToMerge": {
        const input = params as { projectId: ProjectId; confirmOutOfDateBranch?: boolean };
        return this.app.projects.markReadyToMerge(input.projectId, {
          confirmOutOfDateBranch: input.confirmOutOfDateBranch
        });
      }
      case "projects.getWorkspace": {
        const input = params as { projectId: ProjectId };
        return this.app.workspace.getWorkspace(input.projectId);
      }
      case "projects.updateProfile": {
        const input = params as { projectId: ProjectId; profile: Partial<ProjectProfile> };
        return this.app.projects.updateProfile(input.projectId, input.profile);
      }
      case "projects.addSource":
        return this.app.workspace.addSource(params as Parameters<typeof this.app.workspace.addSource>[0]);
      case "projects.removeSource":
        return this.app.workspace.removeSource(params as Parameters<typeof this.app.workspace.removeSource>[0]);
      case "projects.getHome":
        return this.app.workspace.getHome();
      case "projects.getPortfolio":
        return this.app.workspace.getPortfolio();
      case "workItems.create":
        return this.app.workItems.create(params as Parameters<typeof this.app.workItems.create>[0]);
      case "workItems.update":
        return this.app.workItems.update(params as Parameters<typeof this.app.workItems.update>[0]);
      case "workItems.queue":
        return this.app.workItems.queue(params as { projectId: ProjectId; workItemId: ProjectWorkItemId });
      case "workItems.cancel":
        return this.app.workItems.cancel(params as { projectId: ProjectId; workItemId: ProjectWorkItemId });
      case "workItems.complete":
        return this.app.workItems.complete(params as { projectId: ProjectId; workItemId: ProjectWorkItemId });
      case "workItems.listByProject": {
        const input = params as { projectId: ProjectId };
        return this.app.workItems.listByProject(input.projectId);
      }
      case "agentRuns.create":
        return this.app.agentRuns.create(params as Parameters<typeof this.app.agentRuns.create>[0]);
      case "agentRuns.start":
        return this.app.agentRuns.start(params as { projectId: ProjectId; agentRunId: AgentRunId; instruction?: string });
      case "agentRuns.stop":
        return this.app.agentRuns.stop(params as { projectId: ProjectId; agentRunId: AgentRunId; reason?: string });
      case "agentRuns.cancel":
        return this.app.agentRuns.cancel(params as { projectId: ProjectId; agentRunId: AgentRunId });
      case "agentRuns.sendInstruction":
        return this.app.agentRuns.sendInstruction(params as { projectId: ProjectId; agentRunId: AgentRunId; instruction: string });
      case "agentRuns.assignProvider":
        return this.app.agentRuns.assignProvider(params as { projectId: ProjectId; agentRunId: AgentRunId; providerId: ProviderId });
      case "agentRuns.linkSession":
        return this.app.agentRuns.linkSession(params as { projectId: ProjectId; agentRunId: AgentRunId; sessionId: AgentSessionId });
      case "agentRuns.listByProject": {
        const input = params as { projectId: ProjectId };
        return this.app.agentRuns.listByProject(input.projectId);
      }
      case "agentRuns.listByWorkItem":
        return this.app.agentRuns.listByWorkItem(params as { projectId: ProjectId; workItemId: ProjectWorkItemId });
      case "artifacts.create":
        return this.app.artifacts.create(params as Parameters<typeof this.app.artifacts.create>[0]);
      case "artifacts.update":
        return this.app.artifacts.update(params as Parameters<typeof this.app.artifacts.update>[0]);
      case "artifacts.listByProject": {
        const input = params as { projectId: ProjectId };
        return this.app.artifacts.listByProject(input.projectId);
      }
      case "artifacts.get":
        return this.app.artifacts.get(params as { projectId: ProjectId; artifactId: ProjectArtifactId });
      case "artifacts.markReviewed":
        return this.app.artifacts.markReviewed(params as { projectId: ProjectId; artifactId: ProjectArtifactId });
      case "artifacts.accept":
        return this.app.artifacts.accept(params as { projectId: ProjectId; artifactId: ProjectArtifactId });
      case "artifacts.reject":
        return this.app.artifacts.reject(params as { projectId: ProjectId; artifactId: ProjectArtifactId });
      case "providers.list":
        return this.app.providers.listProviders();
      case "providers.getStatus": {
        const input = params as { providerId?: ProviderId };
        return this.app.providers.getStatus(input ?? {});
      }
      case "providers.getCapabilities": {
        const input = params as { providerId?: ProviderId };
        return this.app.providers.getCapabilities(input ?? {});
      }
      case "providers.checkAvailability":
        return this.app.providers.checkAvailability((params as { providerId?: ProviderId }) ?? {});
      case "agents.startSession": {
        const input = params as { providerId: ProviderId; projectId: ProjectId; cwd: string; goal?: string };
        return this.app.providers.startSession(input);
      }
      case "agents.resumeSession":
        return this.app.providers.resumeSession(params as { providerId: ProviderId; sessionId: AgentSessionId });
      case "agents.stopSession":
        return this.app.providers.stopSession(params as { providerId: ProviderId; sessionId: AgentSessionId; reason?: string });
      case "agents.sendTurn": {
        const input = params as {
          providerId: ProviderId;
          projectId: ProjectId;
          sessionId: AgentSessionId;
          instruction: string;
        };
        return this.app.providers.sendTurn(input);
      }
      case "agents.steerTurn":
        return this.app.providers.steerTurn(
          params as { providerId: ProviderId; sessionId: AgentSessionId; turnId: AgentTurnId; input: string }
        );
      case "agents.interruptTurn":
        return this.app.providers.interruptTurn(params as Parameters<typeof this.app.providers.interruptTurn>[0]);
      case "agents.respondToApproval": {
        const input = params as { providerId: ProviderId; approvalId: ApprovalRequestId; decision: ApprovalDecision };
        return this.app.providers.decideApproval(input);
      }
      case "agents.respondToUserInput":
        return this.app.providers.respondToUserInput(
          params as { providerId: ProviderId; sessionId: AgentSessionId; turnId?: AgentTurnId; input: string }
        );
      case "agents.readSession":
        return this.app.providers.readSession(params as { providerId: ProviderId; sessionId: AgentSessionId });
      case "agents.listSessions":
        return this.app.providers.listSessions(
          params as { providerId?: ProviderId; projectId?: ProjectId; cursor?: string; limit?: number }
        );
      case "agents.importSessions":
        return this.app.providers.importSessions(params as { providerId: ProviderId; projectId?: ProjectId });
      case "dashboard.getSnapshot":
      case "dashboard.subscribe":
      case "dashboard.explainMode":
        return this.app.snapshot().dashboard;
      case "dashboard.focusProject": {
        const input = params as { projectId: ProjectId };
        const project = this.app.projects.getProject(input.projectId);
        if (!project || project.archived) {
          throw new PraxisError("not_found", "Project was not found.", { projectId: input.projectId });
        }
        await this.app.events.append(
          createDomainEvent({
            type: "dashboard.projectFocused",
            projectId: input.projectId,
            source: "user",
            payload: { projectId: input.projectId },
            evidence: [{ type: "user", commandId: "dashboard.focusProject" }]
          })
        );
        return this.app.snapshot().dashboard;
      }
      case "dashboard.clearFocus": {
        await this.app.events.append(
          createDomainEvent({
            type: "dashboard.focusCleared",
            source: "user",
            payload: {},
            evidence: [{ type: "user", commandId: "dashboard.clearFocus" }]
          })
        );
        return this.app.snapshot().dashboard;
      }
      case "diagnostics.get":
        return this.app.observability.diagnostics();
      case "settings.get":
        return this.app.settings.get();
      case "settings.update": {
        const input = params as {
          patch: Partial<AppSettings>;
          confirmRawProviderLogs?: boolean;
        };
        if (input.patch.rawProviderLogsEnabled && !this.app.settings.get().rawProviderLogsEnabled && !input.confirmRawProviderLogs) {
          throw new PraxisError("confirmation_required", "Raw provider logs require explicit confirmation.", {
            setting: "rawProviderLogsEnabled"
          });
        }
        const settings = this.app.settings.update(input.patch, {
          confirmRawProviderLogs: input.confirmRawProviderLogs
        });
        await this.app.events.append(
          createDomainEvent({
            type: "settings.updated",
            source: "user",
            payload: {
              updatedKeys: Object.keys(input.patch),
              settings
            },
            evidence: [{ type: "user", commandId: "settings.update" }]
          })
        );
        return settings;
      }
      case "checks.list": {
        const input = params as { projectId: ProjectId };
        return this.app.checks.listDefinitions(input.projectId);
      }
      case "checks.run": {
        const input = params as { projectId: ProjectId; checkId: string };
        const definition = this.app.checks.listDefinitions(input.projectId).find((check) => check.id === input.checkId);
        if (!definition) throw new PraxisError("not_found", "Check definition was not found.");
        return this.app.checks.runCheck(definition);
      }
      case "checks.cancel": {
        const input = params as { runId: CheckRunId };
        return this.app.checks.cancelRun(input.runId);
      }
      case "checks.waive": {
        const input = params as { projectId: ProjectId; checkId: CheckDefinitionId; reason?: string };
        return this.app.checks.waiveCheck({
          projectId: input.projectId,
          checkId: input.checkId,
          reason: input.reason
        });
      }
      case "git.getStatus": {
        const input = params as { rootPath: string };
        return this.app.git.getStatus(input.rootPath);
      }
      case "git.openDiff": {
        const input = params as { rootPath: string };
        return this.app.git.getDiff(input.rootPath);
      }
      case "git.createWorktree": {
        const input = params as { projectId?: ProjectId; rootPath: string; worktreePath: string; branch?: string };
        const created = await this.app.git.createWorktree(input);
        const projectId = input.projectId ?? projectIdForRoot(this.app, input.rootPath);
        await this.app.events.append(
          createDomainEvent({
            type: "git.worktree.created",
            projectId,
            source: "git",
            payload: { path: created.path, branch: created.branch, rootPath: input.rootPath },
            evidence: [{ type: "git", repoPath: input.rootPath }]
          })
        );
        return created;
      }
      case "git.discardChanges": {
        const input = params as { projectId?: ProjectId; rootPath: string; paths: string[]; confirmDiscard?: boolean };
        if (!input.confirmDiscard) {
          throw new PraxisError("confirmation_required", "Discarding changes requires explicit confirmation.", {
            method: "git.discardChanges"
          });
        }
        const result = await this.app.git.discardChanges({ rootPath: input.rootPath, paths: input.paths });
        const projectId = input.projectId ?? projectIdForRoot(this.app, input.rootPath);
        await this.app.events.appendMany([
          createDomainEvent({
            type: "git.changesDiscarded",
            projectId,
            source: "user",
            payload: { rootPath: input.rootPath, paths: result.discardedPaths },
            evidence: [
              { type: "git", repoPath: input.rootPath, sha: result.git.headSha, statusHash: gitStatusHash(result.git) },
              { type: "user", commandId: "git.discardChanges" }
            ]
          }),
          createDomainEvent({
            type: "git.statusChanged",
            projectId,
            source: "git",
            payload: result.git,
            evidence: [{ type: "git", repoPath: input.rootPath, sha: result.git.headSha }]
          })
        ]);
        return result;
      }
      case "events.replay":
        return this.app.replay();
      case "events.query":
        return this.app.events.queryEvents((params as EventQuery | undefined) ?? {});
      default:
        throw new PraxisError("method_not_found", "API method was not found.", { method });
    }
  }
}

function isDashboardSnapshotRequest(method: string): boolean {
  return method === "dashboard.getSnapshot" || method === "dashboard.subscribe" || method === "dashboard.explainMode";
}

function projectIdForRoot(app: PraxisRuntime, rootPath: string): ProjectId | undefined {
  return app.projects.listProjects().find((project) => project.rootPath === rootPath || project.canonicalPath === rootPath)?.id;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof PraxisError) {
    return { code: error.code, message: error.message, details: error.details, evidence: error.evidence };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unexpected error."
  };
}
