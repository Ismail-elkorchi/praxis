import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DomainEvent, EvidenceRef } from "../core/types";
import type { EventQuery, EventStore } from "./EventStore";

type EventRow = {
  id: string;
  sequence: number;
  type: string;
  version: number;
  project_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  provider_id: string | null;
  timestamp: string;
  source: DomainEvent["source"];
  causation_id: string | null;
  correlation_id: string | null;
  payload_json: string;
  evidence_json: string;
};

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.migrate();
  }

  append(event: DomainEvent): Promise<DomainEvent> {
    const sequence = this.nextSequence();
    const stored = { ...event, sequence };

    this.db
      .prepare(
        `INSERT INTO events (
          id, sequence, type, version, project_id, session_id, turn_id, provider_id,
          timestamp, source, causation_id, correlation_id, payload_json, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stored.id,
        stored.sequence,
        stored.type,
        stored.version,
        stored.projectId ?? null,
        stored.sessionId ?? null,
        stored.turnId ?? null,
        stored.providerId ?? null,
        stored.timestamp,
        stored.source,
        stored.causationId ?? null,
        stored.correlationId ?? null,
        JSON.stringify(stored.payload),
        JSON.stringify(stored.evidence)
      );

    return Promise.resolve(stored);
  }

  async appendMany(events: DomainEvent[]): Promise<DomainEvent[]> {
    const stored: DomainEvent[] = [];
    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        stored.push(await this.append(event));
      }
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  query(query: EventQuery = {}): Promise<DomainEvent[]> {
    const clauses: string[] = [];
    const values: (string | number)[] = [];

    if (query.projectId) {
      clauses.push("project_id = ?");
      values.push(query.projectId);
    }
    if (query.sessionId) {
      clauses.push("session_id = ?");
      values.push(query.sessionId);
    }
    if (query.providerId) {
      clauses.push("provider_id = ?");
      values.push(query.providerId);
    }
    if (query.type) {
      clauses.push("type = ?");
      values.push(query.type);
    }
    if (query.afterSequence) {
      clauses.push("sequence > ?");
      values.push(query.afterSequence);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = query.limit ? "LIMIT ?" : "";
    if (query.limit) {
      values.push(query.limit);
    }

    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY sequence ASC ${limit}`)
      .all(...values) as EventRow[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  close(): void {
    this.db.close();
  }

  tableNames(): string[] {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        project_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        provider_id TEXT,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT,
        payload_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        repo_remote TEXT,
        default_branch TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        branch TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        availability_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_capabilities (
        provider_id TEXT PRIMARY KEY,
        capabilities_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        goal TEXT,
        active_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS provider_session_refs (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        external_kind TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(provider_id, external_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        provider_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        requested_action_json TEXT NOT NULL,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS event_payloads (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS check_definitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        command_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        required INTEGER NOT NULL,
        source TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS check_runs (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        exit_code INTEGER,
        stdout_ref TEXT,
        stderr_ref TEXT,
        related_files_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS git_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS propositions (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db
      .prepare("INSERT OR REPLACE INTO schema_versions (id, version, updated_at) VALUES (1, 2, ?)")
      .run(new Date().toISOString());
  }

  private nextSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events").get() as {
      next_sequence: number;
    };
    return row.next_sequence;
  }
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    id: row.id as DomainEvent["id"],
    sequence: row.sequence,
    type: row.type,
    version: row.version,
    projectId: row.project_id ? (row.project_id as DomainEvent["projectId"]) : undefined,
    sessionId: row.session_id ? (row.session_id as DomainEvent["sessionId"]) : undefined,
    turnId: row.turn_id ? (row.turn_id as DomainEvent["turnId"]) : undefined,
    providerId: row.provider_id ? (row.provider_id as DomainEvent["providerId"]) : undefined,
    timestamp: row.timestamp,
    source: row.source,
    causationId: row.causation_id ? (row.causation_id as DomainEvent["causationId"]) : undefined,
    correlationId: row.correlation_id ?? undefined,
    payload: JSON.parse(row.payload_json) as unknown,
    evidence: JSON.parse(row.evidence_json) as EvidenceRef[]
  };
}
