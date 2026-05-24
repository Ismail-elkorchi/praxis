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
        "approvals",
        "check_definitions",
        "check_runs",
        "event_payloads",
        "events",
        "git_snapshots",
        "projects",
        "provider_capabilities",
        "provider_session_refs",
        "providers",
        "propositions",
        "schema_versions",
        "settings",
        "worktrees"
      ])
    );

    store.close();
  });
});
