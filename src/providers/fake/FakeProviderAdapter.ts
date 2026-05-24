import { agentSessionId, eventId, providerId } from "../../core/ids";
import type {
  AgentSessionId,
  DomainEvent,
  ProjectId,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderId,
  ProviderSessionRef
} from "../../core";
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

const now = () => new Date().toISOString();

export const fakeProviderCapabilities: ProviderCapabilities = {
  canStartSession: true,
  canResumeSession: true,
  canListSessions: true,
  canImportExistingSessions: false,
  canStreamEvents: true,
  canStreamTokenDeltas: true,
  canInterruptTurn: true,
  canSteerTurn: true,
  canRequestCommandApproval: true,
  canRequestFileApproval: true,
  canRunShellCommands: true,
  canEditFiles: true,
  canReportFileDiffs: true,
  canReportTokenUsage: false,
  canUseExternalTools: false,
  supportsSandboxing: true,
  supportsPermissionProfiles: true,
  supportsStructuredProtocol: true
};

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId = providerId("fake");
  readonly kind = "fake";
  readonly displayName = "Fake provider";
  readonly adapterVersion = "0.1.0";

  private readonly events: DomainEvent[] = [];

  async getCapabilities(): Promise<ProviderCapabilities> {
    return fakeProviderCapabilities;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return { status: "available", version: this.adapterVersion };
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const sessionId = agentSessionId();
    const providerSessionRef: ProviderSessionRef = {
      providerId: this.id,
      externalId: `fake-session-${sessionId}`,
      externalKind: "scenario"
    };
    const events = [
      this.event("agent.session.started", input.projectId, sessionId, {
        cwd: input.cwd,
        goal: input.goal,
        providerSessionRef
      })
    ];
    this.events.push(...events);
    return { sessionId, providerSessionRef, events };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    this.events.push({
      id: eventId(),
      type: "agent.session.stopped",
      version: 1,
      sessionId: input.sessionId,
      providerId: this.id,
      timestamp: now(),
      source: "provider",
      payload: { reason: input.reason ?? "stopped" },
      evidence: []
    });
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const events = [this.event("agent.turn.started", input.projectId, input.sessionId, { inputSummary: input.input })];
    this.events.push(...events);
    return { events };
  }

  async respondToApproval(_input: ApprovalDecisionInput): Promise<void> {
    return;
  }

  async *watchEvents(_input: WatchProviderEventsInput): AsyncIterable<DomainEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  private event(type: string, projectId: ProjectId, sessionId: AgentSessionId, payload: unknown): DomainEvent {
    return {
      id: eventId(),
      type,
      version: 1,
      projectId,
      sessionId,
      providerId: this.id,
      timestamp: now(),
      source: "provider",
      payload,
      evidence: []
    };
  }
}
