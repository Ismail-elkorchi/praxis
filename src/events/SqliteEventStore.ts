import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultProjectSettings } from "../core/types";
import type {
  AgentProvider,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AgentTurnStatus,
  ApprovalDecision,
  ApprovalRequest,
  CheckDefinition,
  CheckRun,
  DomainEvent,
  EvidenceRef,
  GitSnapshot,
  ProjectArtifact,
  Project,
  ProjectProfile,
  ProjectSource,
  ProjectWorkItem,
  Proposition,
  ProviderAvailability,
  ProviderSessionRef
} from "../core/types";
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

type InspectableTable =
  | "agent_sessions"
  | "agent_turns"
  | "agent_run_session_refs"
  | "agent_runs"
  | "artifact_evidence_refs"
  | "approvals"
  | "check_definitions"
  | "check_runs"
  | "event_payloads"
  | "events"
  | "git_snapshots"
  | "project_artifacts"
  | "project_profiles"
  | "project_sources"
  | "project_work_items"
  | "projects"
  | "provider_capabilities"
  | "provider_session_refs"
  | "providers"
  | "propositions"
  | "schema_versions"
  | "settings"
  | "work_item_artifact_refs"
  | "work_item_source_refs"
  | "worktrees";

const inspectableTables = new Set<InspectableTable>([
  "agent_sessions",
  "agent_turns",
  "agent_run_session_refs",
  "agent_runs",
  "artifact_evidence_refs",
  "approvals",
  "check_definitions",
  "check_runs",
  "event_payloads",
  "events",
  "git_snapshots",
  "project_artifacts",
  "project_profiles",
  "project_sources",
  "project_work_items",
  "projects",
  "provider_capabilities",
  "provider_session_refs",
  "providers",
  "propositions",
  "schema_versions",
  "settings",
  "work_item_artifact_refs",
  "work_item_source_refs",
  "worktrees"
]);

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.configureDatabase(databasePath);
    this.migrate();
  }

  append(event: DomainEvent): Promise<DomainEvent> {
    const insertOne = this.db.transaction((input: DomainEvent) => this.insertEvent(input));
    return Promise.resolve(insertOne(event));
  }

  appendMany(events: DomainEvent[]): Promise<DomainEvent[]> {
    const insertAll = this.db.transaction((input: DomainEvent[]) => input.map((event) => this.insertEvent(event)));
    return Promise.resolve(insertAll(events));
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

  countRows(tableName: InspectableTable): number {
    this.requireInspectableTable(tableName);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  }

  tableRows(tableName: InspectableTable): Record<string, unknown>[] {
    this.requireInspectableTable(tableName);
    return this.db.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, unknown>[];
  }

  readSetting<TValue>(key: string): TValue | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? (JSON.parse(row.value_json) as TValue) : undefined;
  }

  writeSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  writePropositions(propositions: Proposition[]): void {
    this.persistPropositions(propositions);
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    const rows = this.db.pragma("quick_check") as { quick_check: string }[];
    const messages = rows.map((row) => row.quick_check);
    return { ok: messages.length === 1 && messages[0] === "ok", messages };
  }

  private configureDatabase(databasePath: string): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    if (databasePath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
  }

  private insertEvent(event: DomainEvent): DomainEvent {
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

    this.persistReadModels(stored);
    return stored;
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
        package_manager TEXT,
        scripts_json TEXT NOT NULL DEFAULT '[]',
        metadata_files_json TEXT NOT NULL DEFAULT '[]',
        worktrees_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_profiles (
        project_id TEXT PRIMARY KEY,
        user_label TEXT,
        work_modes_json TEXT NOT NULL,
        source_types_json TEXT NOT NULL,
        expected_artifact_types_json TEXT NOT NULL,
        risk_profile_json TEXT,
        custom_tags_json TEXT NOT NULL,
        custom_metadata_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        uri_or_path TEXT,
        content_ref TEXT,
        added_by TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        work_item_id TEXT,
        agent_run_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        content_ref TEXT,
        source_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        work_modes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        session_id TEXT,
        role_name TEXT NOT NULL,
        role_preset TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        cwd TEXT,
        worktree_path TEXT,
        last_event_id TEXT,
        produced_artifact_ids_json TEXT NOT NULL,
        pending_approval_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_run_session_refs (
        agent_run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        linked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_evidence_refs (
        artifact_id TEXT NOT NULL,
        ref_index INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (artifact_id, ref_index)
      );

      CREATE TABLE IF NOT EXISTS work_item_source_refs (
        work_item_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (work_item_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS work_item_artifact_refs (
        work_item_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        PRIMARY KEY (work_item_id, artifact_id)
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
      .prepare("INSERT OR REPLACE INTO schema_versions (id, version, updated_at) VALUES (1, 4, ?)")
      .run(new Date().toISOString());
    this.addColumnIfMissing("projects", "package_manager", "TEXT");
    this.addColumnIfMissing("projects", "scripts_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("projects", "metadata_files_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("projects", "worktrees_json", "TEXT NOT NULL DEFAULT '[]'");
  }

  private nextSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events").get() as {
      next_sequence: number;
    };
    return row.next_sequence;
  }

  private requireInspectableTable(tableName: InspectableTable): void {
    if (!inspectableTables.has(tableName)) {
      throw new Error(`Table is not inspectable: ${tableName}`);
    }
  }

  private addColumnIfMissing(tableName: InspectableTable, columnName: string, definition: string): void {
    this.requireInspectableTable(tableName);
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  private persistReadModels(event: DomainEvent): void {
    this.persistEventPayload(event);
    if (event.version !== 1) {
      return;
    }

    switch (event.type) {
      case "project.registered":
      case "project.updated":
      case "project.archived":
        this.persistProjectEvent(event);
        break;
      case "project.profile.updated":
        this.persistProjectProfile(event.projectId, readProfile(event.payload), event.timestamp);
        break;
      case "project.source.added":
      case "project.source.removed":
        this.persistSourceEvent(event);
        break;
      case "project.artifact.created":
      case "project.artifact.updated":
      case "project.artifact.reviewed":
      case "project.artifact.accepted":
      case "project.artifact.rejected":
        this.persistArtifactEvent(event);
        break;
      case "project.workItem.created":
      case "project.workItem.updated":
      case "project.workItem.queued":
      case "project.workItem.started":
      case "project.workItem.blocked":
      case "project.workItem.completed":
      case "project.workItem.cancelled":
      case "project.workItem.failed":
        this.persistWorkItemEvent(event);
        break;
      case "agent.run.created":
      case "agent.run.queued":
      case "agent.run.started":
      case "agent.run.linkedToSession":
      case "agent.run.statusChanged":
      case "agent.run.outputProduced":
      case "agent.run.blocked":
      case "agent.run.completed":
      case "agent.run.failed":
      case "agent.run.cancelled":
      case "agent.run.stale":
        this.persistAgentRunEvent(event);
        break;
      case "provider.registered":
      case "provider.available":
      case "provider.unavailable":
      case "provider.incompatible":
        this.persistProviderEvent(event);
        break;
      case "agent.session.started":
      case "agent.session.resumed":
      case "agent.session.stale":
      case "agent.session.failed":
      case "agent.session.stopped":
        this.persistSessionEvent(event);
        break;
      case "agent.turn.started":
      case "agent.turn.completed":
      case "agent.turn.failed":
      case "agent.turn.interrupted":
        this.persistTurnEvent(event);
        break;
      case "approval.requested":
      case "approval.accepted":
      case "approval.declined":
      case "approval.cancelled":
      case "approval.expired":
        this.persistApprovalEvent(event);
        break;
      case "check.definitionDetected":
        this.persistCheckDefinitions(readCheckDefinitions(event.payload));
        break;
      case "check.started":
      case "check.completed":
      case "check.failed":
      case "check.cancelled":
      case "check.waived":
        this.persistCheckRun(event.payload as CheckRun);
        break;
      case "git.statusChanged":
        this.persistGitSnapshot(event);
        break;
      case "git.worktree.created":
        this.persistWorktree(event);
        break;
      case "propositions.updated":
        this.persistPropositions(readPropositions(event.payload));
        break;
      default:
        break;
    }
  }

  private persistEventPayload(event: DomainEvent): void {
    const redacted = redactSecretLikeValues(event.payload);
    this.db
      .prepare(
        `INSERT INTO event_payloads (event_id, payload_json, redacted, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(event.id, JSON.stringify(redacted.value), redacted.redacted ? 1 : 0, event.timestamp);
  }

  private persistProjectEvent(event: DomainEvent): void {
    const payload = asRecord(event.payload);
    const project = payload?.project as Project | undefined;
    if (!project) return;

    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, canonical_path, repo_remote, default_branch, package_manager,
          scripts_json, metadata_files_json, worktrees_json, tags_json, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          canonical_path = excluded.canonical_path,
          repo_remote = excluded.repo_remote,
          default_branch = excluded.default_branch,
          package_manager = excluded.package_manager,
          scripts_json = excluded.scripts_json,
          metadata_files_json = excluded.metadata_files_json,
          worktrees_json = excluded.worktrees_json,
          tags_json = excluded.tags_json,
          archived = excluded.archived,
          updated_at = excluded.updated_at`
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.canonicalPath,
        project.repo?.remoteUrl ?? null,
        project.defaultBranch ?? null,
        project.packageManager ?? null,
        JSON.stringify(project.scripts ?? []),
        JSON.stringify(project.metadataFiles ?? []),
        JSON.stringify(project.worktrees ?? []),
        JSON.stringify(project.tags),
        project.archived ? 1 : 0,
        project.createdAt,
        project.updatedAt
      );

    this.persistProjectProfile(project.id, project.profile, project.updatedAt);
    this.persistCheckDefinitions(readCheckDefinitions(event.payload));
    this.writeSetting(`project:${project.id}:settings`, { ...defaultProjectSettings, ...project.settings });
  }

  private persistProjectProfile(projectId: Project["id"] | undefined, profile: ProjectProfile | undefined, updatedAt: string): void {
    if (!projectId || !profile) return;
    this.db
      .prepare(
        `INSERT INTO project_profiles (
          project_id, user_label, work_modes_json, source_types_json, expected_artifact_types_json,
          risk_profile_json, custom_tags_json, custom_metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          user_label = excluded.user_label,
          work_modes_json = excluded.work_modes_json,
          source_types_json = excluded.source_types_json,
          expected_artifact_types_json = excluded.expected_artifact_types_json,
          risk_profile_json = excluded.risk_profile_json,
          custom_tags_json = excluded.custom_tags_json,
          custom_metadata_json = excluded.custom_metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        projectId,
        profile.userLabel ?? null,
        JSON.stringify(profile.workModes ?? []),
        JSON.stringify(profile.sourceTypes ?? []),
        JSON.stringify(profile.expectedArtifactTypes ?? []),
        profile.riskProfile ? JSON.stringify(profile.riskProfile) : null,
        JSON.stringify(profile.customTags ?? []),
        profile.customMetadata ? JSON.stringify(profile.customMetadata) : null,
        updatedAt
      );
  }

  private persistSourceEvent(event: DomainEvent): void {
    if (event.type === "project.source.removed") {
      const sourceId = readString(asRecord(event.payload), "sourceId");
      if (sourceId) {
        this.db.prepare("UPDATE project_sources SET removed_at = ?, updated_at = ? WHERE id = ?").run(event.timestamp, event.timestamp, sourceId);
        this.db.prepare("DELETE FROM work_item_source_refs WHERE source_id = ?").run(sourceId);
      }
      return;
    }

    const source = readSource(event.payload);
    if (!source) return;
    this.db
      .prepare(
        `INSERT INTO project_sources (
          id, project_id, type, title, uri_or_path, content_ref, added_by, metadata_json, created_at, updated_at, removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          uri_or_path = excluded.uri_or_path,
          content_ref = excluded.content_ref,
          added_by = excluded.added_by,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          removed_at = NULL`
      )
      .run(
        source.id,
        source.projectId,
        source.type,
        source.title,
        source.uriOrPath ?? null,
        source.contentRef ?? null,
        source.addedBy,
        JSON.stringify(source.metadata ?? {}),
        source.createdAt,
        source.updatedAt
      );
  }

  private persistArtifactEvent(event: DomainEvent): void {
    const artifact = readArtifact(event.payload);
    if (!artifact) return;
    this.db
      .prepare(
        `INSERT INTO project_artifacts (
          id, project_id, work_item_id, agent_run_id, type, title, summary, status, content_ref,
          source_ids_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          work_item_id = excluded.work_item_id,
          agent_run_id = excluded.agent_run_id,
          type = excluded.type,
          title = excluded.title,
          summary = excluded.summary,
          status = excluded.status,
          content_ref = excluded.content_ref,
          source_ids_json = excluded.source_ids_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        artifact.id,
        artifact.projectId,
        artifact.workItemId ?? null,
        artifact.agentRunId ?? null,
        artifact.type,
        artifact.title,
        artifact.summary,
        artifact.status,
        artifact.contentRef ?? null,
        JSON.stringify(artifact.sourceIds ?? []),
        JSON.stringify(artifact.metadata ?? {}),
        artifact.createdAt,
        artifact.updatedAt
      );

    this.db.prepare("DELETE FROM artifact_evidence_refs WHERE artifact_id = ?").run(artifact.id);
    artifact.evidence.forEach((evidence, index) => {
      this.db
        .prepare("INSERT INTO artifact_evidence_refs (artifact_id, ref_index, evidence_json) VALUES (?, ?, ?)")
        .run(artifact.id, index, JSON.stringify(evidence));
    });
    if (artifact.workItemId) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO work_item_artifact_refs (work_item_id, artifact_id)
           VALUES (?, ?)`
        )
        .run(artifact.workItemId, artifact.id);
    }
  }

  private persistWorkItemEvent(event: DomainEvent): void {
    const workItem = readWorkItem(event.payload);
    if (!workItem) return;
    this.db
      .prepare(
        `INSERT INTO project_work_items (
          id, project_id, title, goal, work_modes_json, status, priority, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          goal = excluded.goal,
          work_modes_json = excluded.work_modes_json,
          status = excluded.status,
          priority = excluded.priority,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        workItem.id,
        workItem.projectId,
        workItem.title,
        workItem.goal,
        JSON.stringify(workItem.workModes ?? []),
        workItem.status,
        workItem.priority,
        JSON.stringify(workItem.metadata ?? {}),
        workItem.createdAt,
        workItem.updatedAt
      );

    this.db.prepare("DELETE FROM work_item_source_refs WHERE work_item_id = ?").run(workItem.id);
    for (const sourceId of workItem.sourceIds) {
      this.db.prepare("INSERT OR IGNORE INTO work_item_source_refs (work_item_id, source_id) VALUES (?, ?)").run(workItem.id, sourceId);
    }
    this.db.prepare("DELETE FROM work_item_artifact_refs WHERE work_item_id = ?").run(workItem.id);
    for (const artifactId of workItem.artifactIds) {
      this.db.prepare("INSERT OR IGNORE INTO work_item_artifact_refs (work_item_id, artifact_id) VALUES (?, ?)").run(workItem.id, artifactId);
    }
  }

  private persistAgentRunEvent(event: DomainEvent): void {
    const run = readAgentRun(event.payload);
    if (!run) return;
    this.db
      .prepare(
        `INSERT INTO agent_runs (
          id, project_id, work_item_id, provider_id, session_id, role_name, role_preset, goal, status,
          cwd, worktree_path, last_event_id, produced_artifact_ids_json, pending_approval_ids_json,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          work_item_id = excluded.work_item_id,
          provider_id = excluded.provider_id,
          session_id = excluded.session_id,
          role_name = excluded.role_name,
          role_preset = excluded.role_preset,
          goal = excluded.goal,
          status = excluded.status,
          cwd = excluded.cwd,
          worktree_path = excluded.worktree_path,
          last_event_id = excluded.last_event_id,
          produced_artifact_ids_json = excluded.produced_artifact_ids_json,
          pending_approval_ids_json = excluded.pending_approval_ids_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        run.id,
        run.projectId,
        run.workItemId,
        run.providerId,
        run.sessionId ?? null,
        run.roleName,
        run.rolePreset ?? null,
        run.goal,
        run.status,
        run.cwd ?? null,
        run.worktreePath ?? null,
        run.lastEventId ?? event.id,
        JSON.stringify(run.producedArtifactIds ?? []),
        JSON.stringify(run.pendingApprovalIds ?? []),
        JSON.stringify(run.metadata ?? {}),
        run.createdAt,
        run.updatedAt
      );

    if (run.sessionId) {
      this.db
        .prepare(
          `INSERT INTO agent_run_session_refs (agent_run_id, session_id, provider_id, linked_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_run_id) DO UPDATE SET
             session_id = excluded.session_id,
             provider_id = excluded.provider_id,
             linked_at = excluded.linked_at`
        )
        .run(run.id, run.sessionId, run.providerId, event.timestamp);
    }
  }

  private persistProviderEvent(event: DomainEvent): void {
    const payload = asRecord(event.payload);
    const provider = payload?.provider as AgentProvider | undefined;
    const availability = payload?.availability as ProviderAvailability | undefined;

    if (provider) {
      this.db
        .prepare(
          `INSERT INTO providers (id, kind, display_name, adapter_version, availability_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             display_name = excluded.display_name,
             adapter_version = excluded.adapter_version,
             availability_json = excluded.availability_json,
             updated_at = excluded.updated_at`
        )
        .run(
          provider.id,
          provider.kind,
          provider.displayName,
          provider.adapterVersion,
          JSON.stringify(provider.availability),
          event.timestamp
        );

      this.db
        .prepare(
          `INSERT INTO provider_capabilities (provider_id, capabilities_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET
             capabilities_json = excluded.capabilities_json,
             updated_at = excluded.updated_at`
        )
        .run(provider.id, JSON.stringify(provider.capabilities), event.timestamp);
      return;
    }

    if (event.providerId && availability) {
      this.db
        .prepare("UPDATE providers SET availability_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(availability), event.timestamp, event.providerId);
    }
  }

  private persistSessionEvent(event: DomainEvent): void {
    if (!event.projectId || !event.sessionId || !event.providerId) return;
    const payload = asRecord(event.payload);

    if (event.type === "agent.session.started") {
      const sessionPayload = payload as Partial<AgentSession> | undefined;
      const cwd = typeof sessionPayload?.cwd === "string" ? sessionPayload.cwd : "";
      const goal = typeof sessionPayload?.goal === "string" ? sessionPayload.goal : null;
      this.upsertSession({
        id: event.sessionId,
        projectId: event.projectId,
        providerId: event.providerId,
        cwd,
        state: "active",
        goal,
        activeTurnId: null,
        createdAt: event.timestamp,
        updatedAt: event.timestamp
      });
      this.persistProviderSessionRef(event, sessionPayload?.providerSessionRef);
      return;
    }

    const state = sessionStateForEvent(event.type);
    if (!state) return;
    const updated = this.db
      .prepare("UPDATE agent_sessions SET state = ?, active_turn_id = NULL, updated_at = ? WHERE id = ?")
      .run(state, event.timestamp, event.sessionId);
    if (updated.changes === 0) {
      this.upsertSession({
        id: event.sessionId,
        projectId: event.projectId,
        providerId: event.providerId,
        cwd: typeof payload?.cwd === "string" ? payload.cwd : "",
        state,
        goal: typeof payload?.goal === "string" ? payload.goal : null,
        activeTurnId: null,
        createdAt: event.timestamp,
        updatedAt: event.timestamp
      });
    }
  }

  private persistTurnEvent(event: DomainEvent): void {
    if (!event.projectId || !event.sessionId || !event.turnId || !event.providerId) return;

    if (event.type === "agent.turn.started") {
      const payload = asRecord(event.payload);
      const inputSummary = String(payload?.inputSummary ?? "Agent turn");
      this.db
        .prepare(
          `INSERT INTO agent_turns (
            id, session_id, project_id, provider_id, status, input_summary, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            input_summary = excluded.input_summary,
            completed_at = NULL`
        )
        .run(event.turnId, event.sessionId, event.projectId, event.providerId, "in_progress", inputSummary, event.timestamp);
      this.db
        .prepare("UPDATE agent_sessions SET state = ?, active_turn_id = ?, updated_at = ? WHERE id = ?")
        .run("active", event.turnId, event.timestamp, event.sessionId);
      return;
    }

    const status = turnStatusForEvent(event.type);
    if (!status) return;
    this.db
      .prepare("UPDATE agent_turns SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, event.timestamp, event.turnId);
    this.db
      .prepare("UPDATE agent_sessions SET state = ?, active_turn_id = NULL, updated_at = ? WHERE id = ?")
      .run(status === "failed" ? "failed" : "idle", event.timestamp, event.sessionId);
  }

  private persistApprovalEvent(event: DomainEvent): void {
    if (event.type === "approval.requested") {
      const approval = event.payload as ApprovalRequest;
      this.db
        .prepare(
          `INSERT INTO approvals (
            id, project_id, session_id, turn_id, provider_id, kind, risk, status, title, description,
            requested_action_json, decision_json, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            title = excluded.title,
            description = excluded.description,
            requested_action_json = excluded.requested_action_json`
        )
        .run(
          approval.id,
          approval.projectId,
          approval.sessionId,
          approval.turnId ?? null,
          approval.providerId,
          approval.kind,
          approval.risk,
          approval.status,
          approval.title,
          approval.description,
          JSON.stringify(approval.requestedAction),
          approval.createdAt
        );
      this.db
        .prepare("UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?")
        .run("waiting_for_approval", event.timestamp, approval.sessionId);
      return;
    }

    const payload = asRecord(event.payload);
    const approvalId = payload?.approvalId;
    if (typeof approvalId !== "string") return;
    const status = approvalStatusForEvent(event.type);
    if (!status) return;
    const decision = typeof payload?.decision === "string" ? (payload.decision as ApprovalDecision) : undefined;
    const resolvedAt = typeof payload?.resolvedAt === "string" ? payload.resolvedAt : event.timestamp;
    this.db
      .prepare("UPDATE approvals SET status = ?, decision_json = ?, resolved_at = ? WHERE id = ?")
      .run(status, JSON.stringify({ decision, eventId: event.id }), resolvedAt, approvalId);
  }

  private persistCheckDefinitions(definitions: CheckDefinition[]): void {
    for (const definition of definitions) {
      this.db
        .prepare(
          `INSERT INTO check_definitions (
            id, project_id, name, command_json, cwd, timeout_ms, required, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            command_json = excluded.command_json,
            cwd = excluded.cwd,
            timeout_ms = excluded.timeout_ms,
            required = excluded.required,
            source = excluded.source`
        )
        .run(
          definition.id,
          definition.projectId,
          definition.name,
          JSON.stringify(definition.command),
          definition.cwd,
          definition.timeoutMs,
          definition.required ? 1 : 0,
          definition.source
        );
    }
  }

  private persistCheckRun(run: CheckRun): void {
    if (!run?.id) return;
    this.db
      .prepare(
        `INSERT INTO check_runs (
          id, check_id, project_id, status, started_at, completed_at, exit_code, stdout_ref, stderr_ref, related_files_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          completed_at = excluded.completed_at,
          exit_code = excluded.exit_code,
          stdout_ref = excluded.stdout_ref,
          stderr_ref = excluded.stderr_ref,
          related_files_json = excluded.related_files_json`
      )
      .run(
        run.id,
        run.checkId,
        run.projectId,
        run.status,
        run.startedAt,
        run.completedAt ?? null,
        run.exitCode ?? null,
        run.stdoutRef ?? null,
        run.stderrRef ?? null,
        JSON.stringify(run.relatedFiles)
      );
  }

  private persistGitSnapshot(event: DomainEvent): void {
    if (!event.projectId) return;
    const snapshot = event.payload as GitSnapshot;
    this.db
      .prepare(
        `INSERT INTO git_snapshots (id, project_id, snapshot_json, captured_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(`git_snapshot:${event.projectId}:${event.sequence ?? event.id}`, event.projectId, JSON.stringify(snapshot), event.timestamp);
  }

  private persistWorktree(event: DomainEvent): void {
    if (!event.projectId) return;
    const payload = asRecord(event.payload);
    const rootPath = typeof payload?.path === "string" ? payload.path : undefined;
    if (!rootPath) return;
    this.db
      .prepare(
        `INSERT INTO worktrees (id, project_id, root_path, branch, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           root_path = excluded.root_path,
           branch = excluded.branch`
      )
      .run(
        typeof payload?.id === "string" ? payload.id : `worktree:${event.projectId}:${event.sequence ?? event.id}`,
        event.projectId,
        rootPath,
        typeof payload?.branch === "string" ? payload.branch : null,
        event.timestamp
      );
  }

  private persistPropositions(propositions: Proposition[]): void {
    for (const proposition of propositions) {
      this.db
        .prepare(
          `INSERT INTO propositions (id, subject, predicate, value, evidence_json, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             value = excluded.value,
             evidence_json = excluded.evidence_json,
             checked_at = excluded.checked_at`
        )
        .run(
          proposition.id,
          proposition.subject,
          proposition.predicate,
          proposition.value,
          JSON.stringify(proposition.evidence),
          proposition.checkedAt
        );
    }
  }

  private upsertSession(input: {
    id: string;
    projectId: string;
    providerId: string;
    cwd: string;
    state: AgentSessionState;
    goal: string | null;
    activeTurnId: string | null;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (
          id, project_id, provider_id, cwd, state, goal, active_turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cwd = excluded.cwd,
          state = excluded.state,
          goal = COALESCE(excluded.goal, agent_sessions.goal),
          active_turn_id = excluded.active_turn_id,
          updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.projectId,
        input.providerId,
        input.cwd,
        input.state,
        input.goal,
        input.activeTurnId,
        input.createdAt,
        input.updatedAt
      );
  }

  private persistProviderSessionRef(event: DomainEvent, ref: ProviderSessionRef | undefined): void {
    if (!event.sessionId || !event.providerId || !ref?.externalId) return;
    this.db
      .prepare(
        `INSERT INTO provider_session_refs (
          id, provider_id, session_id, external_id, external_kind, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, external_id) DO UPDATE SET
          session_id = excluded.session_id,
          external_kind = excluded.external_kind,
          metadata_json = excluded.metadata_json`
      )
      .run(
        `provider_ref:${event.providerId}:${event.sessionId}`,
        event.providerId,
        event.sessionId,
        ref.externalId,
        ref.externalKind ?? null,
        ref.metadata ? JSON.stringify(ref.metadata) : null,
        event.timestamp
      );
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readCheckDefinitions(payload: unknown): CheckDefinition[] {
  const record = asRecord(payload);
  const definitions = record?.checkDefinitions;
  return Array.isArray(definitions) ? (definitions as CheckDefinition[]) : [];
}

function readPropositions(payload: unknown): Proposition[] {
  const record = asRecord(payload);
  const propositions = record?.propositions;
  return Array.isArray(propositions) ? (propositions as Proposition[]) : [];
}

function readProfile(payload: unknown): ProjectProfile | undefined {
  const record = asRecord(payload);
  return (asRecord(record?.profile) ?? record) as ProjectProfile | undefined;
}

function readSource(payload: unknown): ProjectSource | undefined {
  const record = asRecord(payload);
  return (asRecord(record?.source) ?? record) as ProjectSource | undefined;
}

function readArtifact(payload: unknown): ProjectArtifact | undefined {
  const record = asRecord(payload);
  return (asRecord(record?.artifact) ?? record) as ProjectArtifact | undefined;
}

function readWorkItem(payload: unknown): ProjectWorkItem | undefined {
  const record = asRecord(payload);
  return (asRecord(record?.workItem) ?? record) as ProjectWorkItem | undefined;
}

function readAgentRun(payload: unknown): AgentRun | undefined {
  const record = asRecord(payload);
  return (asRecord(record?.agentRun) ?? record) as AgentRun | undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function sessionStateForEvent(type: string): AgentSessionState | undefined {
  if (type === "agent.session.resumed") return "active";
  if (type === "agent.session.stale") return "stale_or_disconnected";
  if (type === "agent.session.failed") return "failed";
  if (type === "agent.session.stopped") return "stopped";
  return undefined;
}

function turnStatusForEvent(type: string): AgentTurnStatus | undefined {
  if (type === "agent.turn.completed") return "completed";
  if (type === "agent.turn.failed") return "failed";
  if (type === "agent.turn.interrupted") return "interrupted";
  return undefined;
}

function approvalStatusForEvent(type: string): ApprovalRequest["status"] | undefined {
  if (type === "approval.accepted") return "accepted";
  if (type === "approval.declined") return "declined";
  if (type === "approval.cancelled") return "cancelled";
  if (type === "approval.expired") return "expired";
  return undefined;
}

function redactSecretLikeValues(value: unknown): { value: unknown; redacted: boolean } {
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactSecretLikeValues(item);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }

  const record = asRecord(value);
  if (!record) {
    return { value, redacted: false };
  }

  let redacted = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (isSecretLikeKey(key)) {
      next[key] = "[REDACTED]";
      redacted = true;
      continue;
    }
    const result = redactSecretLikeValues(nested);
    next[key] = result.value;
    redacted = redacted || result.redacted;
  }

  return { value: next, redacted };
}

function isSecretLikeKey(key: string): boolean {
  return /api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token/i.test(key);
}
