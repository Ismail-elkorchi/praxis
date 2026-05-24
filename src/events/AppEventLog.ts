import { performance } from "node:perf_hooks";
import type { DomainEvent } from "../core/types";
import type { AppSnapshot } from "../dashboard/types";
import { emptySnapshot, replayEvents, reduceSnapshot } from "../dashboard/reducers";
import type { EventQuery, EventStore } from "./EventStore";

export type EventIngestionObservation = {
  eventId: DomainEvent["id"];
  eventType: DomainEvent["type"];
  providerId?: DomainEvent["providerId"];
  projectId?: DomainEvent["projectId"];
  source: DomainEvent["source"];
  eventTimestamp: DomainEvent["timestamp"];
  ingestedAt: string;
  ingestionLatencyMs: number;
  appendDurationMs: number;
  projectionUpdateDurationMs: number;
};

export type ProjectionTimingObservation = {
  operation: "append" | "appendMany" | "restore" | "replay";
  eventCount: number;
  durationMs: number;
  recordedAt: string;
};

export type EventLogTelemetry = {
  eventIngestion: EventIngestionObservation[];
  projectionTimings: ProjectionTimingObservation[];
};

type PropositionSink = {
  writePropositions(propositions: AppSnapshot["dashboard"]["explanation"]["propositions"]): void;
};

export class AppEventLog {
  private current: AppSnapshot = emptySnapshot();
  private readonly eventIngestion: EventIngestionObservation[] = [];
  private readonly projectionTimings: ProjectionTimingObservation[] = [];

  constructor(private readonly store: EventStore) {}

  async append(event: DomainEvent): Promise<DomainEvent> {
    const appendStarted = performance.now();
    const stored = await this.store.append(event);
    const appendDurationMs = performance.now() - appendStarted;
    const projectionStarted = performance.now();
    this.current = reduceSnapshot(this.current, stored);
    const projectionUpdateDurationMs = performance.now() - projectionStarted;
    this.recordEventIngestion(stored, appendDurationMs, projectionUpdateDurationMs);
    this.recordProjectionTiming("append", 1, projectionUpdateDurationMs);
    this.persistPropositions();
    return stored;
  }

  async appendMany(events: DomainEvent[]): Promise<DomainEvent[]> {
    const appendStarted = performance.now();
    const stored = await this.store.appendMany(events);
    const appendDurationMs = performance.now() - appendStarted;
    const projectionStarted = performance.now();
    for (const event of stored) {
      const eventProjectionStarted = performance.now();
      this.current = reduceSnapshot(this.current, event);
      this.recordEventIngestion(
        event,
        stored.length === 0 ? 0 : appendDurationMs / stored.length,
        performance.now() - eventProjectionStarted
      );
    }
    this.recordProjectionTiming("appendMany", stored.length, performance.now() - projectionStarted);
    this.persistPropositions();
    return stored;
  }

  async restore(): Promise<AppSnapshot> {
    const started = performance.now();
    const events = await this.store.query();
    this.current = replayEvents(events);
    this.recordProjectionTiming("restore", events.length, performance.now() - started);
    this.persistPropositions();
    return this.current;
  }

  async replay(): Promise<AppSnapshot> {
    const started = performance.now();
    const events = await this.store.query();
    const snapshot = replayEvents(events);
    this.recordProjectionTiming("replay", events.length, performance.now() - started);
    return snapshot;
  }

  snapshot(): AppSnapshot {
    return this.current;
  }

  async queryEvents(query?: EventQuery) {
    return this.store.query(query);
  }

  telemetry(): EventLogTelemetry {
    return {
      eventIngestion: this.eventIngestion.map((entry) => ({ ...entry })),
      projectionTimings: this.projectionTimings.map((entry) => ({ ...entry }))
    };
  }

  private persistPropositions(): void {
    if (!isPropositionSink(this.store)) return;
    this.store.writePropositions(
      Object.values(this.current.projects).flatMap((project) => project.propositions)
    );
  }

  private recordEventIngestion(
    event: DomainEvent,
    appendDurationMs: number,
    projectionUpdateDurationMs: number
  ): void {
    const ingestedAt = new Date().toISOString();
    const eventTime = Date.parse(event.timestamp);
    const ingestionLatencyMs = Number.isFinite(eventTime) ? Math.max(0, Date.parse(ingestedAt) - eventTime) : 0;
    this.eventIngestion.push({
      eventId: event.id,
      eventType: event.type,
      providerId: event.providerId,
      projectId: event.projectId,
      source: event.source,
      eventTimestamp: event.timestamp,
      ingestedAt,
      ingestionLatencyMs,
      appendDurationMs,
      projectionUpdateDurationMs
    });
    trim(this.eventIngestion, 500);
  }

  private recordProjectionTiming(
    operation: ProjectionTimingObservation["operation"],
    eventCount: number,
    durationMs: number
  ): void {
    this.projectionTimings.push({
      operation,
      eventCount,
      durationMs,
      recordedAt: new Date().toISOString()
    });
    trim(this.projectionTimings, 200);
  }
}

function isPropositionSink(value: EventStore): value is EventStore & PropositionSink {
  return "writePropositions" in value && typeof value.writePropositions === "function";
}

function trim<T>(items: T[], maxLength: number): void {
  if (items.length > maxLength) {
    items.splice(0, items.length - maxLength);
  }
}
