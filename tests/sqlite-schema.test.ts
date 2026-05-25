import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/SqliteEventStore";

describe("SQLite migrations", () => {
  it("creates the durable tables named by the persistence specification", () => {
    const databasePath = path.join(os.tmpdir(), `praxis-schema-${crypto.randomUUID()}.sqlite`);
    const store = new SqliteEventStore(databasePath);

    expect(store.tableNames()).toEqual(
      expect.arrayContaining([
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
      ])
    );

    store.close();
  });
});
