import type { AgentSessionId, AgentTurnId, ApprovalDecision, ApprovalRequestId, CheckRunId, ProjectId, ProviderId } from "../core";
import { createDomainEvent } from "../events/eventFactory";
import type { EventQuery } from "../events/EventStore";
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
  "dashboard.getSnapshot",
  "dashboard.subscribe",
  "dashboard.explainMode",
  "checks.list",
  "checks.run",
  "checks.cancel",
  "git.getStatus",
  "git.openDiff",
  "git.createWorktree",
  "events.replay",
  "events.query"
] as const;

export type ApiMethod = (typeof apiMethods)[number];

export class PraxisApi {
  constructor(private readonly app: PraxisRuntime) {}

  async handle(request: ClientRequest): Promise<ServerResponse> {
    try {
      return { id: request.id, result: await this.dispatch(request.method as ApiMethod, request.params) };
    } catch (error) {
      return { id: request.id, error: toApiError(error) };
    }
  }

  private async dispatch(method: ApiMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "projects.list":
        return this.app.projects.listProjects();
      case "projects.register": {
        const input = params as { rootPath: string; name?: string; defaultProviderId?: ProviderId };
        return this.app.projects.registerProject(input);
      }
      case "projects.update": {
        const input = params as { projectId: ProjectId; patch: { name?: string; tags?: string[]; archived?: boolean } };
        return this.app.projects.updateProject(input.projectId, input.patch);
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
      case "dashboard.getSnapshot":
      case "dashboard.subscribe":
      case "dashboard.explainMode":
        return this.app.snapshot().dashboard;
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
      case "events.replay":
        return this.app.replay();
      case "events.query":
        return this.app.events.queryEvents((params as EventQuery | undefined) ?? {});
      default:
        throw new PraxisError("method_not_found", "API method was not found.", { method });
    }
  }
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
