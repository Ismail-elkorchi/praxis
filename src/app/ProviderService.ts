import {
  agentSessionId,
  agentTurnId,
  approvalRequestId,
  commandRunId,
  fileChangeId,
  type AgentSessionId,
  type AgentTurnId,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalRequestId,
  type DomainEvent,
  type ProjectId,
  type ProviderId
} from "../core";
import type { AppSnapshot } from "../dashboard/types";
import { createDomainEvent } from "../events/eventFactory";
import type { AppEventLog } from "../events/AppEventLog";
import type { ProviderAdapter } from "../providers/interface";
import { capabilityError, notFoundError, PraxisError } from "./errors";
import type { ProviderRegistry } from "./ProviderRegistry";

export class ProviderService {
  private readonly seenProviderEvents = new Set<string>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly events: AppEventLog,
    private readonly getSnapshot: () => AppSnapshot
  ) {}

  async registerAvailableProviders(): Promise<void> {
    const providers = await this.registry.listProviders();
    await this.events.appendMany(
      providers.map((provider) =>
        createDomainEvent({
          type: "provider.registered",
          providerId: provider.id,
          source: "system",
          payload: { provider },
          evidence: []
        })
      )
    );
  }

  async startSession(input: {
    providerId: ProviderId;
    projectId: ProjectId;
    cwd: string;
    goal?: string;
  }): Promise<AgentSessionId> {
    const adapter = this.requireAdapter(input.providerId);
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.canStartSession) {
      throw capabilityError("Provider does not support starting sessions.", { providerId: input.providerId });
    }

    const availability = await adapter.checkAvailability();
    if (availability.status !== "available") {
      const sessionId = agentSessionId();
      await this.events.appendMany([
        createDomainEvent({
          type: "provider.error",
          projectId: input.projectId,
          sessionId,
          providerId: input.providerId,
          source: "provider",
          payload: { message: availability.reason, availability },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.session.failed",
          projectId: input.projectId,
          sessionId,
          providerId: input.providerId,
          source: "system",
          payload: { reason: availability.reason },
          evidence: []
        })
      ]);
      throw new PraxisError("provider_unavailable", availability.reason, { providerId: input.providerId });
    }

    const sessionId = agentSessionId();
    try {
      const result = await adapter.startSession({ ...input, sessionId });
      const normalized = ensureSessionStartedEvent(result.events, input.projectId, input.providerId, result.sessionId ?? sessionId);
      await this.recordProviderEvents(normalized);
      return result.sessionId ?? sessionId;
    } catch (error) {
      await this.events.appendMany([
        createDomainEvent({
          type: "provider.error",
          projectId: input.projectId,
          sessionId,
          providerId: input.providerId,
          source: "provider",
          payload: { message: error instanceof Error ? error.message : "Provider failed to start a session." },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.session.failed",
          projectId: input.projectId,
          sessionId,
          providerId: input.providerId,
          source: "system",
          payload: { reason: "Session start failed." },
          evidence: []
        })
      ]);
      throw error;
    }
  }

  async sendTurn(input: {
    providerId: ProviderId;
    projectId: ProjectId;
    sessionId: AgentSessionId;
    instruction: string;
  }): Promise<AgentTurnId> {
    const adapter = this.requireAdapter(input.providerId);
    const turnId = agentTurnId();
    const result = await adapter.sendTurn({
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnId,
      input: input.instruction
    });
    await this.recordProviderEvents(result.events);
    return result.turnId ?? turnId;
  }

  async interruptTurn(input: {
    providerId: ProviderId;
    sessionId: AgentSessionId;
    turnId: AgentTurnId;
    reason?: string;
  }): Promise<void> {
    const adapter = this.requireAdapter(input.providerId);
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.canInterruptTurn || !adapter.interruptTurn) {
      throw capabilityError("Provider does not support interrupting turns.", { providerId: input.providerId });
    }

    await adapter.interruptTurn(input);
    await this.ingestProviderEvents(adapter, input.sessionId);
  }

  async decideApproval(input: {
    providerId: ProviderId;
    approvalId: ApprovalRequestId;
    decision: ApprovalDecision;
  }): Promise<void> {
    const snapshot = this.getSnapshot();
    const approval = findApproval(snapshot, input.approvalId);
    if (!approval) {
      throw notFoundError("Approval request was not found.", { approvalId: input.approvalId });
    }
    if (approval.status !== "pending") {
      throw new PraxisError("approval_already_resolved", "Approval request is already resolved.", {
        approvalId: input.approvalId
      });
    }

    const eventType = approvalEventType(input.decision);
    const decisionEvent = await this.events.append(
      createDomainEvent({
        type: eventType,
        projectId: approval.projectId,
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        providerId: input.providerId,
        source: "user",
        payload: {
          approvalId: input.approvalId,
          decision: input.decision,
          resolvedAt: new Date().toISOString()
        },
        evidence: [{ type: "approval", approvalId: input.approvalId, decision: input.decision }]
      })
    );

    const adapter = this.requireAdapter(input.providerId);
    try {
      await adapter.respondToApproval({
        approvalId: input.approvalId,
        sessionId: approval.sessionId,
        decision: input.decision
      });
      await this.ingestProviderEvents(adapter, approval.sessionId);
    } catch (error) {
      await this.events.append(
        createDomainEvent({
          type: "provider.error",
          projectId: approval.projectId,
          sessionId: approval.sessionId,
          turnId: approval.turnId,
          providerId: input.providerId,
          source: "provider",
          causationId: decisionEvent.id,
          payload: { message: error instanceof Error ? error.message : "Provider failed to receive approval decision." },
          evidence: [{ type: "event", eventId: decisionEvent.id }]
        })
      );
      throw error;
    }
  }

  createApprovalRequest(input: {
    projectId: ProjectId;
    sessionId: AgentSessionId;
    turnId?: AgentTurnId;
    providerId: ProviderId;
    kind: ApprovalRequest["kind"];
    risk: ApprovalRequest["risk"];
    title: string;
    description: string;
    requestedAction: unknown;
    riskSignals?: ApprovalRequest["riskSignals"];
  }): ApprovalRequest {
    const id = approvalRequestId();
    return {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: input.providerId,
      kind: input.kind,
      risk: input.risk,
      riskSignals: input.riskSignals ?? [],
      title: input.title,
      description: input.description,
      requestedAction: input.requestedAction,
      status: "pending",
      createdAt: new Date().toISOString(),
      evidence: [{ type: "approval", approvalId: id }]
    };
  }

  commandRunId() {
    return commandRunId();
  }

  fileChangeId() {
    return fileChangeId();
  }

  private requireAdapter(providerId: ProviderId): ProviderAdapter {
    const adapter = this.registry.get(providerId);
    if (!adapter) {
      throw notFoundError("Provider is not registered.", { providerId });
    }
    return adapter;
  }

  private async ingestProviderEvents(adapter: ProviderAdapter, sessionId?: AgentSessionId): Promise<void> {
    const events: DomainEvent[] = [];
    for await (const event of adapter.watchEvents({ sessionId })) {
      if (!this.seenProviderEvents.has(event.id)) {
        events.push(event);
      }
    }
    await this.recordProviderEvents(events);
  }

  private async recordProviderEvents(events: DomainEvent[]): Promise<void> {
    const unseen = events.filter((event) => !this.seenProviderEvents.has(event.id));
    for (const event of unseen) {
      this.seenProviderEvents.add(event.id);
    }
    if (unseen.length > 0) {
      await this.events.appendMany(unseen);
    }
  }
}

function findApproval(snapshot: AppSnapshot, approvalId: ApprovalRequestId): ApprovalRequest | undefined {
  return Object.values(snapshot.projects)
    .flatMap((project) => project.approvals)
    .find((approval) => approval.id === approvalId);
}

function approvalEventType(decision: ApprovalDecision): "approval.accepted" | "approval.declined" | "approval.cancelled" {
  if (decision === "decline") return "approval.declined";
  if (decision === "cancel") return "approval.cancelled";
  return "approval.accepted";
}

function ensureSessionStartedEvent(
  events: DomainEvent[],
  projectId: ProjectId,
  providerId: ProviderId,
  sessionId: AgentSessionId
): DomainEvent[] {
  if (events.some((event) => event.type === "agent.session.started")) {
    return events;
  }
  return [
    createDomainEvent({
      type: "agent.session.started",
      projectId,
      sessionId,
      providerId,
      source: "provider",
      payload: { cwd: "", providerSessionRef: undefined },
      evidence: []
    }),
    ...events
  ];
}
