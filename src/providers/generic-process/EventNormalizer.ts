import type { AgentSessionId, AgentTurnId, DomainEvent, ProjectId, ProviderId } from "../../core";
import { createDomainEvent } from "../../events/eventFactory";

export function normalizeProcessLine(input: {
  line: string;
  projectId: ProjectId;
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
  providerId: ProviderId;
}): DomainEvent {
  try {
    const parsed = JSON.parse(input.line) as Partial<DomainEvent> & { rawType?: string };
    if (!parsed.type || typeof parsed.type !== "string") {
      return rawEvent(input, { normalizationFailure: "missing_event_type", payload: parsed });
    }
    if (!knownProviderEventTypes.has(parsed.type)) {
      return rawEvent(input, {
        normalizationFailure: "unknown_event_type",
        rawType: parsed.type,
        payload: parsed.payload ?? parsed
      });
    }

    return createDomainEvent({
      type: parsed.type,
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: input.providerId,
      source: "provider",
      payload: parsed.payload ?? {},
      evidence: parsed.evidence ?? []
    });
  } catch {
    return rawEvent(input, { normalizationFailure: "invalid_json", line: input.line });
  }
}

function rawEvent(
  input: {
    line: string;
    projectId: ProjectId;
    sessionId: AgentSessionId;
    turnId?: AgentTurnId;
    providerId: ProviderId;
  },
  payload: unknown
): DomainEvent {
  return createDomainEvent({
    type: "provider.rawEvent",
    projectId: input.projectId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.providerId,
    source: "provider",
    payload,
    evidence: []
  });
}

const knownProviderEventTypes = new Set([
  "agent.session.started",
  "agent.session.resumed",
  "agent.session.stopped",
  "agent.session.stale",
  "agent.session.failed",
  "agent.turn.started",
  "agent.turn.delta",
  "agent.turn.completed",
  "agent.turn.failed",
  "agent.turn.interrupted",
  "agent.command.started",
  "agent.command.output",
  "agent.command.completed",
  "agent.command.failed",
  "agent.command.cancelled",
  "agent.fileChange.proposed",
  "agent.fileChange.applied",
  "agent.fileChange.rejected",
  "approval.requested",
  "agent.userInput.requested",
  "provider.rawEvent",
  "provider.error"
]);
