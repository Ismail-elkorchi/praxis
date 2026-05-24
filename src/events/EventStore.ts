import type { DomainEvent } from "../core/types";

export type EventQuery = {
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  type?: string;
  afterSequence?: number;
  limit?: number;
};

export interface EventStore {
  append(event: DomainEvent): Promise<DomainEvent>;
  appendMany(events: DomainEvent[]): Promise<DomainEvent[]>;
  query(query?: EventQuery): Promise<DomainEvent[]>;
  close?(): void;
}

export class InMemoryEventStore implements EventStore {
  private events: DomainEvent[] = [];

  async append(event: DomainEvent): Promise<DomainEvent> {
    if (this.events.some((existing) => existing.id === event.id)) {
      throw new Error(`Event already exists: ${event.id}`);
    }

    const stored = { ...event, sequence: this.events.length + 1 };
    this.events = [...this.events, stored];
    return stored;
  }

  async appendMany(events: DomainEvent[]): Promise<DomainEvent[]> {
    const stored: DomainEvent[] = [];
    for (const event of events) {
      stored.push(await this.append(event));
    }
    return stored;
  }

  async query(query: EventQuery = {}): Promise<DomainEvent[]> {
    return this.events
      .filter((event) => {
        if (query.projectId && event.projectId !== query.projectId) return false;
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.providerId && event.providerId !== query.providerId) return false;
        if (query.type && event.type !== query.type) return false;
        if (query.afterSequence && (event.sequence ?? 0) <= query.afterSequence) return false;
        return true;
      })
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .slice(0, query.limit);
  }
}
