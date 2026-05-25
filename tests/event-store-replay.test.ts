import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createDomainEvent } from "../src/events/eventFactory";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import { createTempProject } from "./helpers/tempProject";

describe("event store and replay", () => {
  it("assigns append-only sequence numbers and replays to the live projection", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Complete" });

    const events = await app.events.queryEvents();
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    await expect(app.eventStore.append(events[0]!)).rejects.toThrow();
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("restores approval history from SQLite after restart", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-db-")), "praxis.sqlite");
    const first = await createPraxisApp({ eventStore: new SqliteEventStore(databasePath), fakeScenario: "approval_path" });
    const rootPath = await createTempProject();
    const project = await first.projects.registerProject({ rootPath });
    const sessionId = await first.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    await first.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Approve" });
    const approval = first.snapshot().approvals.pending[0]!;
    await first.providers.decideApproval({ providerId: providerId("fake"), approvalId: approval.id, decision: "decline" });
    first.eventStore.close?.();

    const second = await createPraxisApp({ eventStore: new SqliteEventStore(databasePath) });
    expect(second.snapshot().approvals.history.find((item) => item.id === approval.id)?.status).toBe("declined");
    second.eventStore.close?.();
  });

  it("stores unknown event versions for audit without mutating projections", async () => {
    const store = new SqliteEventStore(path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-db-")), "praxis.sqlite"));
    const app = await createPraxisApp({ eventStore: store });

    await app.events.append(
      createDomainEvent({
        type: "project.registered",
        version: 99,
        source: "system",
        payload: { incompatible: true },
        evidence: []
      })
    );

    expect((await app.events.queryEvents({ type: "project.registered" }))[0]?.version).toBe(99);
    expect(app.snapshot().projects).toEqual({});
    expect(store.countRows("events")).toBeGreaterThan(0);
    expect(store.countRows("projects")).toBe(0);
    await expect(app.replay()).resolves.toEqual(app.snapshot());
    store.close();
  });
});
