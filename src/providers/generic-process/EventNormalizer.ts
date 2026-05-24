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
      return rawEvent(input, parsed);
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
    return rawEvent(input, { line: input.line });
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
