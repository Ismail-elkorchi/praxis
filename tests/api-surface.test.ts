import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiMethods, PraxisApi } from "../src/app/PraxisApi";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import { createTempProject } from "./helpers/tempProject";

const requiredApiMethods = [
  "projects.list",
  "projects.register",
  "projects.update",
  "projects.archive",
  "projects.refresh",
  "providers.list",
  "providers.getStatus",
  "providers.getCapabilities",
  "providers.checkAvailability",
  "agents.startSession",
  "agents.resumeSession",
  "agents.stopSession",
  "agents.sendTurn",
  "agents.steerTurn",
  "agents.interruptTurn",
  "agents.respondToApproval",
  "agents.respondToUserInput",
  "agents.readSession",
  "agents.listSessions",
  "dashboard.getSnapshot",
  "dashboard.subscribe",
  "dashboard.explainMode",
  "checks.list",
  "checks.run",
  "checks.cancel",
  "git.getStatus",
  "git.openDiff",
  "git.createWorktree",
  "events.replay",
  "events.query"
];

describe("provider-neutral API surface", () => {
  it("contains every method named by the API specification without provider-specific names", () => {
    expect(apiMethods).toEqual(requiredApiMethods);
    expect(apiMethods.some((method) => /openai|anthropic|gemini|claude|codex/i.test(method))).toBe(false);
  });

  it("updates, archives, and refreshes projects through event-producing API calls", async () => {
    const app = await createPraxisApp();
    const api = new PraxisApi(app);
    const rootPath = await createTempProject({ packageJson: false });
    const registered = await api.handle({
      id: "register",
      method: "projects.register",
      params: { rootPath, name: "Initial" }
    });
    const project = "result" in registered ? (registered.result as { id: string; settings: { defaultProviderId?: string } }) : undefined;
    expect(project).toBeDefined();
    expect(project!.settings.defaultProviderId).toBeUndefined();

    await expect(
      api.handle({
        id: "update",
        method: "projects.update",
        params: {
          projectId: project!.id,
          patch: {
            name: "Updated",
            settings: {
              defaultProviderId: providerId("fake"),
              defaultCheckIds: ["check-default"],
              preferredWorktreeMode: "task_isolated",
              showInDashboard: false
            }
          }
        }
      })
    ).resolves.toMatchObject({
      id: "update",
      result: {
        name: "Updated",
        settings: {
          defaultProviderId: providerId("fake"),
          defaultCheckIds: ["check-default"],
          preferredWorktreeMode: "task_isolated",
          showInDashboard: false
        }
      }
    });
    expect(app.projects.listProjects().some((item) => item.id === project!.id)).toBe(true);
    expect(app.snapshot().dashboard.projectCards.some((card) => card.projectId === project!.id)).toBe(false);
    await expect(api.handle({ id: "refresh", method: "projects.refresh", params: { projectId: project!.id } })).resolves.toMatchObject({
      id: "refresh"
    });
    await expect(api.handle({ id: "archive", method: "projects.archive", params: { projectId: project!.id } })).resolves.toMatchObject({
      id: "archive"
    });

    const eventTypes = (await app.events.queryEvents()).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["project.updated", "project.archived", "git.statusChanged"]));
  });

  it("restores project settings from event history after restart", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-project-settings-")), "praxis.sqlite");
    const firstStore = new SqliteEventStore(databasePath);
    const first = await createPraxisApp({ eventStore: firstStore });
    const api = new PraxisApi(first);
    const rootPath = await createTempProject({ packageJson: false });
    const project = await first.projects.registerProject({ rootPath });

    await api.handle({
      id: "settings",
      method: "projects.update",
      params: {
        projectId: project.id,
        patch: {
          settings: {
            defaultProviderId: providerId("fake"),
            defaultCheckIds: ["test"],
            preferredWorktreeMode: "task_isolated",
            autoRefreshGit: false,
            showInDashboard: false
          }
        }
      }
    });
    first.eventStore.close?.();

    const secondStore = new SqliteEventStore(databasePath);
    const second = await createPraxisApp({ eventStore: secondStore });
    expect(second.projects.getProject(project.id)?.settings).toMatchObject({
      defaultProviderId: providerId("fake"),
      defaultCheckIds: ["test"],
      preferredWorktreeMode: "task_isolated",
      autoRefreshGit: false,
      showInDashboard: false
    });
    expect(second.snapshot().dashboard.projectCards.some((card) => card.projectId === project.id)).toBe(false);
    expect(secondStore.tableRows("settings").some((row) => row.key === `project:${project.id}:settings`)).toBe(true);
    second.eventStore.close?.();
  });

  it("returns capability errors for unsupported optional agent methods and lists local sessions", async () => {
    const app = await createPraxisApp();
    const api = new PraxisApi(app);
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await expect(
      api.handle({ id: "resume", method: "agents.resumeSession", params: { providerId: providerId("fake"), sessionId } })
    ).resolves.toMatchObject({ id: "resume", result: undefined });

    await expect(
      api.handle({
        id: "steer",
        method: "agents.steerTurn",
        params: { providerId: providerId("fake"), sessionId, turnId: "turn_missing", input: "Adjust course" }
      })
    ).resolves.toMatchObject({ id: "steer", result: undefined });

    await expect(
      api.handle({ id: "input", method: "agents.respondToUserInput", params: { providerId: providerId("fake"), sessionId, input: "yes" } })
    ).resolves.toMatchObject({ id: "input", error: { code: "capability_unavailable" } });

    await expect(
      api.handle({ id: "list", method: "agents.listSessions", params: { providerId: providerId("fake"), projectId: project.id } })
    ).resolves.toMatchObject({ id: "list", result: { sessions: [expect.objectContaining({ id: sessionId })] } });
    await expect(
      api.handle({ id: "read", method: "agents.readSession", params: { providerId: providerId("fake"), sessionId } })
    ).resolves.toMatchObject({ id: "read", result: expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) }) });
  });

  it("responds to pending user input through the API when the provider supports it", async () => {
    const app = await createPraxisApp({ fakeScenario: "user_input_path" });
    const api = new PraxisApi(app);
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    const turnId = await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Ask" });

    await expect(
      api.handle({
        id: "input",
        method: "agents.respondToUserInput",
        params: { providerId: providerId("fake"), sessionId, turnId, input: "Continue with the smallest durable design." }
      })
    ).resolves.toMatchObject({ id: "input", result: undefined });
    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.state).toBe("idle");
  });

  it("returns targeted provider status and emits availability events", async () => {
    const app = await createPraxisApp();
    const api = new PraxisApi(app);

    await expect(
      api.handle({ id: "status", method: "providers.getStatus", params: { providerId: providerId("fake") } })
    ).resolves.toMatchObject({ id: "status", result: { status: "available" } });
    await expect(
      api.handle({ id: "capabilities", method: "providers.getCapabilities", params: { providerId: providerId("fake") } })
    ).resolves.toMatchObject({ id: "capabilities", result: { canStartSession: true } });

    app.fakeProvider.setScenario("unavailable_path");
    await expect(
      api.handle({ id: "availability", method: "providers.checkAvailability", params: { providerId: providerId("fake") } })
    ).resolves.toMatchObject({ id: "availability", result: { status: "unavailable" } });
    expect((await app.events.queryEvents()).map((event) => event.type)).toContain("provider.unavailable");
    expect(app.snapshot().dashboard.providerStatus[0]?.availability.status).toBe("unavailable");
  });

  it("emits a provider-neutral event for worktree creation", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-worktree-db-")), "praxis.sqlite");
    const store = new SqliteEventStore(databasePath);
    const app = await createPraxisApp({ eventStore: store });
    const api = new PraxisApi(app);
    const rootPath = await createTempProject({ git: true });
    const project = await app.projects.registerProject({ rootPath });
    const worktreePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-worktree-")), "task");

    await expect(
      api.handle({
        id: "worktree",
        method: "git.createWorktree",
        params: {
          projectId: project.id,
          rootPath,
          worktreePath,
          branch: `task-${randomUUID()}`
        }
      })
    ).resolves.toMatchObject({ id: "worktree", result: { path: worktreePath } });

    expect((await app.events.queryEvents()).map((event) => event.type)).toContain("git.worktree.created");
    expect(store.countRows("worktrees")).toBe(1);
    expect(store.tableRows("worktrees")[0]).toMatchObject({ project_id: project.id, root_path: worktreePath });
    store.close();
  });

  it("filters event queries by project, provider, session, and event type", async () => {
    const app = await createPraxisApp();
    const api = new PraxisApi(app);
    const firstRoot = await createTempProject({ packageJson: false });
    const secondRoot = await createTempProject({ packageJson: false });
    const first = await app.projects.registerProject({ rootPath: firstRoot });
    const second = await app.projects.registerProject({ rootPath: secondRoot });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: first.id,
      cwd: firstRoot
    });
    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: first.id,
      sessionId,
      instruction: "Filter this activity"
    });

    await expect(
      api.handle({ id: "project-events", method: "events.query", params: { projectId: first.id } })
    ).resolves.toMatchObject({
      id: "project-events",
      result: expect.arrayContaining([expect.objectContaining({ projectId: first.id })])
    });
    const secondEvents = await api.handle({ id: "second-events", method: "events.query", params: { projectId: second.id } });
    expect("result" in secondEvents ? (secondEvents.result as { projectId?: string }[]).every((event) => event.projectId === second.id) : false).toBe(
      true
    );

    await expect(
      api.handle({ id: "session-events", method: "events.query", params: { providerId: providerId("fake"), sessionId } })
    ).resolves.toMatchObject({
      id: "session-events",
      result: expect.arrayContaining([expect.objectContaining({ sessionId, providerId: providerId("fake") })])
    });
    await expect(
      api.handle({ id: "type-events", method: "events.query", params: { type: "agent.turn.completed" } })
    ).resolves.toMatchObject({
      id: "type-events",
      result: [expect.objectContaining({ type: "agent.turn.completed" })]
    });
  });
});
