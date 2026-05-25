import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  agentSessionId,
  providerId,
  type AgentSessionId,
  type DomainEvent,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderSessionRef
} from "../../core";
import { createDomainEvent } from "../../events/eventFactory";
import type {
  ApprovalDecisionInput,
  ProviderAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput,
  StartSessionResult,
  StopSessionInput,
  WatchProviderEventsInput
} from "../interface";
import { executableIsAvailable } from "./Compatibility";
import { normalizeProcessLine } from "./EventNormalizer";

const execFileAsync = promisify(execFile);

export type GenericProcessProviderConfig = {
  id?: ProviderId;
  displayName?: string;
  command: string[];
  timeoutMs?: number;
};

export class GenericProcessProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly kind = "generic-process";
  readonly displayName: string;
  readonly adapterVersion = "0.1.0";

  private readonly events: DomainEvent[] = [];
  private readonly timeoutMs: number;

  constructor(private readonly config: GenericProcessProviderConfig) {
    this.id = config.id ?? providerId("generic-process");
    this.displayName = config.displayName ?? "Generic process provider";
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      canStartSession: true,
      canResumeSession: false,
      canListSessions: false,
      canImportExistingSessions: false,
      canStreamEvents: true,
      canStreamTokenDeltas: false,
      canInterruptTurn: false,
      canSteerTurn: false,
      canRequestCommandApproval: true,
      canRequestFileApproval: true,
      canRunShellCommands: true,
      canEditFiles: true,
      canReportFileDiffs: true,
      canReportTokenUsage: false,
      canUseExternalTools: false,
      supportsSandboxing: false,
      supportsPermissionProfiles: false,
      supportsStructuredProtocol: true
    };
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    const executable = this.config.command[0];
    if (!executable) {
      return { status: "unavailable", reason: "No provider command configured." };
    }
    if (!(await executableIsAvailable(executable))) {
      return { status: "unavailable", reason: "Configured provider command is not available." };
    }
    return { status: "available", version: this.adapterVersion };
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const sessionId = input.sessionId ?? agentSessionId();
    const providerSessionRef: ProviderSessionRef = {
      providerId: this.id,
      externalId: `process-session-${sessionId}`,
      externalKind: "process"
    };
    const event = createDomainEvent({
      type: "agent.session.started",
      projectId: input.projectId,
      sessionId,
      providerId: this.id,
      source: "provider",
      payload: { cwd: input.cwd, goal: input.goal, providerSessionRef },
      evidence: []
    });
    this.events.push(event);
    return { sessionId, providerSessionRef, events: [event] };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    this.events.push(
      createDomainEvent({
        type: "agent.session.stopped",
        sessionId: input.sessionId,
        providerId: this.id,
        source: "provider",
        payload: { reason: input.reason ?? "stopped" },
        evidence: []
      })
    );
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const turnId = input.turnId;
    const processStartedAt = performance.now();
    const started = createDomainEvent({
      type: "agent.turn.started",
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId,
      providerId: this.id,
      source: "provider",
      payload: { inputSummary: input.input },
      evidence: []
    });
    const clientStarted = createDomainEvent({
      type: "provider.client.started",
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId,
      providerId: this.id,
      source: "provider",
      payload: { message: "Provider client started.", executable: this.config.command[0] ?? "" },
      evidence: []
    });

    try {
      const result = await execFileAsync(this.config.command[0] ?? "", this.config.command.slice(1), {
        timeout: this.timeoutMs,
        env: {
          ...process.env,
          PRAXIS_PROVIDER_INPUT: JSON.stringify({
            projectId: input.projectId,
            sessionId: input.sessionId,
            turnId,
            input: input.input
          })
        },
        maxBuffer: 10 * 1024 * 1024
      });
      const normalized = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) =>
          normalizeProcessLine({
            line,
            projectId: input.projectId,
            sessionId: input.sessionId,
            turnId,
            providerId: this.id
          })
        );
      const completed = normalized.some((event) => event.type === "agent.turn.completed")
        ? []
        : [
            createDomainEvent({
              type: "agent.turn.completed",
              projectId: input.projectId,
              sessionId: input.sessionId,
              turnId,
              providerId: this.id,
              source: "provider",
              payload: { result: "Process provider completed." },
              evidence: []
            })
          ];
      const clientStopped = createDomainEvent({
        type: "provider.client.stopped",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: {
          message: "Provider client stopped.",
          exitCode: 0,
          durationMs: performance.now() - processStartedAt
        },
        evidence: [{ type: "event", eventId: clientStarted.id }]
      });
      const events = [started, clientStarted, ...normalized, ...completed, clientStopped];
      this.events.push(...events);
      return { turnId, events };
    } catch (error) {
      const clientStopped = createDomainEvent({
        type: "provider.client.stopped",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: {
          message: "Provider client stopped after failure.",
          exitCode: typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : undefined,
          durationMs: performance.now() - processStartedAt
        },
        evidence: [{ type: "event", eventId: clientStarted.id }]
      });
      const failed = [
        started,
        clientStarted,
        createDomainEvent({
          type: "provider.error",
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { message: error instanceof Error ? error.message : "Provider process failed." },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.turn.failed",
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { reason: "Provider process failed." },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.session.stale",
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { reason: "Provider process failed." },
          evidence: []
        }),
        clientStopped
      ];
      this.events.push(...failed);
      return { turnId, events: failed };
    }
  }

  async respondToApproval(_input: ApprovalDecisionInput): Promise<void> {
    return;
  }

  async *watchEvents(_input: WatchProviderEventsInput): AsyncIterable<DomainEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}
