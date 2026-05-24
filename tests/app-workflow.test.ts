import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createTempProject } from "./helpers/tempProject";

describe("provider-neutral application workflow", () => {
  it("starts with the fake provider and no real providers", async () => {
    const app = await createPraxisApp();

    expect(app.providerRegistry.listRealProviders()).toEqual([]);
    expect(app.snapshot().dashboard.providerStatus).toHaveLength(1);
    expect(app.snapshot().dashboard.providerStatus[0]?.availability.status).toBe("available");
  });

  it("registers and deduplicates a project by canonical path", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true });

    const first = await app.projects.registerProject({ rootPath });
    const second = await app.projects.registerProject({ rootPath: path.join(rootPath, ".") });

    expect(second.id).toBe(first.id);
    expect(app.snapshot().dashboard.projectCards).toHaveLength(1);
    expect(app.snapshot().projects[first.id]?.git.isRepo).toBe(true);
    expect(app.snapshot().projects[first.id]?.checkDefinitions.map((check) => check.name)).toContain("test");
  });

  it("runs the approval path and stores the decision before provider continuation events", async () => {
    const app = await createPraxisApp({ fakeScenario: "approval_path" });
    const rootPath = await createTempProject({ git: true });
    const project = await app.projects.registerProject({ rootPath });

    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath,
      goal: "Exercise approval flow"
    });
    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Run the check"
    });

    expect(app.snapshot().dashboard.mode).toBe("approval_center");
    expect(app.snapshot().approvals.pending).toHaveLength(1);

    const approval = app.snapshot().approvals.pending[0];
    expect(approval).toBeDefined();
    await app.providers.decideApproval({
      providerId: providerId("fake"),
      approvalId: approval.id,
      decision: "accept_once"
    });

    const events = await app.events.queryEvents();
    const decisionIndex = events.findIndex((event) => event.type === "approval.accepted");
    const continuationIndex = events.findIndex((event) => event.type === "agent.command.started");
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeGreaterThan(decisionIndex);
    expect(app.snapshot().approvals.pending).toHaveLength(0);
    expect(app.snapshot().approvals.history[0]?.status).toBe("accepted");
  });

  it("applies fake file changes and makes the project reviewable when checks are not required", async () => {
    const app = await createPraxisApp({ fakeScenario: "file_change_path" });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath
    });

    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Edit a file"
    });
    const approval = app.snapshot().approvals.pending[0];
    await app.providers.decideApproval({ providerId: providerId("fake"), approvalId: approval.id, decision: "accept_once" });

    expect(app.snapshot().projects[project.id]?.fileChanges.some((change) => change.status === "applied")).toBe(true);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("ready_for_review");
    expect(app.snapshot().dashboard.mode).toBe("diff_review");
  });

  it("marks stale sessions on provider disconnect", async () => {
    const app = await createPraxisApp({ fakeScenario: "stale_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Continue" });

    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("stale");
    expect(app.snapshot().dashboard.mode).toBe("stale_sessions");
  });

  it("stores unknown provider events without mutating project state from the raw event", async () => {
    const app = await createPraxisApp({ fakeScenario: "unknown_event_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const before = app.snapshot().projects[project.id]?.runtimeState;
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Emit unknown" });

    const rawEvents = (await app.events.queryEvents()).filter((event) => event.type === "provider.rawEvent");
    expect(rawEvents).toHaveLength(1);
    expect(app.snapshot().dashboard.timeline.some((item) => item.title === "provider.rawEvent")).toBe(false);
    expect(before).toBe("idle");
  });

  it("interrupts only when provider capability supports it", async () => {
    const app = await createPraxisApp({ fakeScenario: "stale_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    const turnId = await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Run" });

    await expect(
      app.providers.interruptTurn({ providerId: providerId("fake"), sessionId, turnId, reason: "User requested stop" })
    ).resolves.toBeUndefined();
  });

  it("updates dirty git state and links failed check output to changed files", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true, failingTest: true });
    await writeFile(path.join(rootPath, "new-file.ts"), "export const value = 1;\n");
    const project = await app.projects.registerProject({ rootPath });
    const definition = app.checks.listDefinitions(project.id).find((check) => check.name === "test");
    expect(definition).toBeDefined();

    const run = await app.checks.runCheck(definition!);

    expect(run.status).toBe("failed");
    expect(run.relatedFiles).toContain("new-file.ts");
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("checks_failed");
    expect(app.snapshot().dashboard.mode).toBe("failure_triage");
  });
});
