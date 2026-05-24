import { eventId } from "../core/ids";
import type { DomainEvent, DomainEventSource, EvidenceRef } from "../core/types";

const now = () => new Date().toISOString();

export type DomainEventInput<TType extends string, TPayload> = {
  type: TType;
  version?: number;
  projectId?: DomainEvent["projectId"];
  sessionId?: DomainEvent["sessionId"];
  turnId?: DomainEvent["turnId"];
  providerId?: DomainEvent["providerId"];
  source: DomainEventSource;
  causationId?: DomainEvent["causationId"];
  correlationId?: string;
  payload: TPayload;
  evidence?: EvidenceRef[];
  timestamp?: string;
};

export function createDomainEvent<TType extends string, TPayload>(
  input: DomainEventInput<TType, TPayload>
): DomainEvent<TType, TPayload> {
  return {
    id: eventId(),
    type: input.type,
    version: input.version ?? 1,
    projectId: input.projectId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.providerId,
    timestamp: input.timestamp ?? now(),
    source: input.source,
    causationId: input.causationId,
    correlationId: input.correlationId,
    payload: input.payload,
    evidence: input.evidence ?? []
  };
}
