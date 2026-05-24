import type { DomainEvent } from "../core/types";
import type { AppSnapshot } from "../dashboard/types";
import { emptySnapshot, replayEvents, reduceSnapshot } from "../dashboard/reducers";
import type { EventStore } from "./EventStore";

type PropositionSink = {
  writePropositions(propositions: AppSnapshot["dashboard"]["explanation"]["propositions"]): void;
};

export class AppEventLog {
  private current: AppSnapshot = emptySnapshot();

  constructor(private readonly store: EventStore) {}

  async append(event: DomainEvent): Promise<DomainEvent> {
    const stored = await this.store.append(event);
    this.current = reduceSnapshot(this.current, stored);
    this.persistPropositions();
    return stored;
  }

  async appendMany(events: DomainEvent[]): Promise<DomainEvent[]> {
    const stored = await this.store.appendMany(events);
    for (const event of stored) {
      this.current = reduceSnapshot(this.current, event);
    }
    this.persistPropositions();
    return stored;
  }

  async restore(): Promise<AppSnapshot> {
    const events = await this.store.query();
    this.current = replayEvents(events);
    this.persistPropositions();
    return this.current;
  }

  async replay(): Promise<AppSnapshot> {
    return replayEvents(await this.store.query());
  }

  snapshot(): AppSnapshot {
    return this.current;
  }

  async queryEvents() {
    return this.store.query();
  }

  private persistPropositions(): void {
    if (!isPropositionSink(this.store)) return;
    this.store.writePropositions(
      Object.values(this.current.projects).flatMap((project) => project.propositions)
    );
  }
}

function isPropositionSink(value: EventStore): value is EventStore & PropositionSink {
  return "writePropositions" in value && typeof value.writePropositions === "function";
}
