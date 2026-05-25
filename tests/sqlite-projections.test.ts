import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createDomainEvent } from "../src/events/eventFactory";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import { createTempProject } from "./helpers/tempProject";

describe("SQLite durable projections", () => {
  it("persists provider-neutral read models while keeping replay event-sourced", async () => {
    const store = new SqliteEventStore(await databasePath());
    const app = await createPraxisApp({ eventStore: store, fakeScenario: "approval_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath,
      goal: "Exercise durable projections"
    });

    const turnId = await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Request approval"
    });
    const approval = app.snapshot().approvals.pending[0]!;
    await app.providers.decideApproval({
      providerId: providerId("fake"),
      approvalId: approval.id,
      decision: "accept_once"
    });
    const checkRun = await app.checks.runCheck(app.checks.listDefinitions(project.id)[0]!);
    const events = await app.events.queryEvents();

    expect(store.countRows("event_payloads")).toBe(events.length);
    expect(store.countRows("projects")).toBe(1);
    expect(store.countRows("providers")).toBe(1);
    expect(store.countRows("provider_capabilities")).toBe(1);
    expect(store.countRows("provider_session_refs")).toBe(1);
    expect(store.countRows("agent_sessions")).toBe(1);
    expect(store.countRows("agent_turns")).toBe(1);
    expect(store.countRows("approvals")).toBe(1);
    expect(store.countRows("check_definitions")).toBeGreaterThanOrEqual(1);
    expect(store.countRows("check_runs")).toBe(1);
    expect(store.countRows("git_snapshots")).toBe(1);
    expect(store.countRows("propositions")).toBeGreaterThan(0);
    expect(store.countRows("settings")).toBeGreaterThanOrEqual(2);
    await expect(app.replay()).resolves.toEqual(app.snapshot());

    const provider = store.tableRows("providers")[0]!;
    expect(provider.id).toBe("fake");
    expect(JSON.parse(String(provider.availability_json))).toMatchObject({ status: "available" });

    const projectRow = store.tableRows("projects")[0]!;
    expect(projectRow.package_manager).toBe("npm");
    expect(JSON.parse(String(projectRow.scripts_json))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "test", source: "package_json", confidence: "high" })])
    );
    expect(JSON.parse(String(projectRow.metadata_files_json))).toContainEqual({ path: "package.json", kind: "package" });
    expect(JSON.parse(String(projectRow.worktrees_json))).toEqual([]);

    const capabilities = store.tableRows("provider_capabilities")[0]!;
    expect(JSON.parse(String(capabilities.capabilities_json))).toMatchObject({ canStartSession: true });

    const providerRef = store.tableRows("provider_session_refs")[0]!;
    expect(providerRef.session_id).toBe(sessionId);
    expect(providerRef.external_id).toBe(`fake-session-${sessionId}`);
    expect(providerRef.id).not.toBe(providerRef.external_id);

    const session = store.tableRows("agent_sessions")[0]!;
    expect(session.id).toBe(sessionId);
    expect(session.state).toBe("idle");
    expect(session.goal).toBe("Exercise durable projections");

    const turn = store.tableRows("agent_turns")[0]!;
    expect(turn.id).toBe(turnId);
    expect(turn.status).toBe("completed");

    const approvalRow = store.tableRows("approvals")[0]!;
    expect(approvalRow.status).toBe("accepted");
    expect(JSON.parse(String(approvalRow.decision_json))).toMatchObject({ decision: "accept_once" });

    const checkRow = store.tableRows("check_runs")[0]!;
    expect(checkRow.id).toBe(checkRun.id);
    expect(checkRow.status).toBe("passed");

    const projectSettings = store.tableRows("settings").find((row) => row.key === `project:${project.id}:settings`);
    expect(JSON.parse(String(projectSettings!.value_json))).toMatchObject({
      preferredWorktreeMode: "manual",
      showInDashboard: true
    });

    const proposition = store.tableRows("propositions").find((row) => String(row.predicate) === "ready_for_review");
    expect(proposition).toBeDefined();
    expect(JSON.parse(String(proposition!.evidence_json))).toEqual(expect.any(Array));
    store.close();
  });

  it("preserves events across migration startup", async () => {
    const database = await databasePath();
    const first = new SqliteEventStore(database);
    const event = await first.append(
      createDomainEvent({
        type: "provider.rawEvent",
        providerId: providerId("fake"),
        source: "provider",
        payload: { rawType: "audit.only" },
        evidence: []
      })
    );
    first.close();

    const second = new SqliteEventStore(database);
    await expect(second.query()).resolves.toMatchObject([{ id: event.id, sequence: 1, type: "provider.rawEvent" }]);
    expect(second.countRows("events")).toBe(1);
    second.close();
  });

  it("stores redacted audit payload copies for secret-like fields", async () => {
    const store = new SqliteEventStore(await databasePath());
    await store.append(
      createDomainEvent({
        type: "provider.rawEvent",
        providerId: providerId("fake"),
        source: "provider",
        payload: { token: "plain-token", nested: { password: "plain-password" }, visible: "kept" },
        evidence: []
      })
    );

    const payload = store.tableRows("event_payloads")[0]!;
    expect(payload.redacted).toBe(1);
    expect(JSON.parse(String(payload.payload_json))).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      visible: "kept"
    });
    store.close();
  });
});

async function databasePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-sqlite-")), `${randomUUID()}.sqlite`);
}
