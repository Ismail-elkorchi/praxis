import type { AgentSessionId, ApprovalDecision, ApprovalRequestId, ProjectId, ProviderId } from "../core";
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
};

export type ServerResponse = { id: string; result: unknown } | { id: string; error: ApiError };

export const apiMethods = [
  "projects.list",
  "projects.register",
  "projects.refresh",
  "providers.list",
  "providers.getStatus",
  "providers.getCapabilities",
  "providers.checkAvailability",
  "agents.startSession",
  "agents.stopSession",
  "agents.sendTurn",
  "agents.interruptTurn",
  "agents.respondToApproval",
  "dashboard.getSnapshot",
  "dashboard.explainMode",
  "checks.list",
  "checks.run",
  "git.getStatus",
  "git.openDiff",
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
      case "projects.refresh":
        return this.app.snapshot().dashboard.projectCards;
      case "providers.list":
        return this.app.providerRegistry.listProviders();
      case "providers.getStatus":
      case "providers.getCapabilities":
      case "providers.checkAvailability":
        return this.app.providerRegistry.listProviders();
      case "agents.startSession": {
        const input = params as { providerId: ProviderId; projectId: ProjectId; cwd: string; goal?: string };
        return this.app.providers.startSession(input);
      }
      case "agents.sendTurn": {
        const input = params as {
          providerId: ProviderId;
          projectId: ProjectId;
          sessionId: AgentSessionId;
          instruction: string;
        };
        return this.app.providers.sendTurn(input);
      }
      case "agents.interruptTurn":
        return this.app.providers.interruptTurn(params as Parameters<typeof this.app.providers.interruptTurn>[0]);
      case "agents.respondToApproval": {
        const input = params as { providerId: ProviderId; approvalId: ApprovalRequestId; decision: ApprovalDecision };
        return this.app.providers.decideApproval(input);
      }
      case "dashboard.getSnapshot":
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
      case "git.getStatus": {
        const input = params as { rootPath: string };
        return this.app.git.getStatus(input.rootPath);
      }
      case "git.openDiff": {
        const input = params as { rootPath: string };
        return this.app.git.getDiff(input.rootPath);
      }
      case "events.replay":
        return this.app.replay();
      case "events.query":
        return this.app.events.queryEvents();
      default:
        throw new PraxisError("method_not_found", "API method was not found.", { method });
    }
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof PraxisError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unexpected error."
  };
}
