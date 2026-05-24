import { describe, expect, it } from "vitest";
import { apiMethods, PraxisApi } from "../src/app/PraxisApi";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
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
    const project = "result" in registered ? (registered.result as { id: string }) : undefined;
    expect(project).toBeDefined();

    await expect(
      api.handle({ id: "update", method: "projects.update", params: { projectId: project!.id, patch: { name: "Updated" } } })
    ).resolves.toMatchObject({ id: "update" });
    await expect(api.handle({ id: "refresh", method: "projects.refresh", params: { projectId: project!.id } })).resolves.toMatchObject({
      id: "refresh"
    });
    await expect(api.handle({ id: "archive", method: "projects.archive", params: { projectId: project!.id } })).resolves.toMatchObject({
      id: "archive"
    });

    const eventTypes = (await app.events.queryEvents()).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["project.updated", "project.archived", "git.statusChanged"]));
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
});
