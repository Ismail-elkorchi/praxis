import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { GenericProcessProviderAdapter } from "../src/providers/generic-process";
import { createTempProject } from "./helpers/tempProject";

describe("GenericProcessProviderAdapter", () => {
  it("is disabled by default and fake-only operation still works", async () => {
    const app = await createPraxisApp();

    expect(app.providerRegistry.listRealProviders()).toHaveLength(0);
    expect(app.snapshot().dashboard.providerStatus.map((provider) => provider.name)).toEqual(["Fake provider"]);
  });

  it("passes the provider contract for availability, session start, turn send, and unknown event handling", async () => {
    const scriptPath = await createProviderScript();
    const adapter = new GenericProcessProviderAdapter({
      id: providerId("generic-process-test"),
      displayName: "Generic process provider",
      command: [process.execPath, scriptPath]
    });
    const app = await createPraxisApp({ providerAdapters: [adapter] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });

    await expect(adapter.checkAvailability()).resolves.toMatchObject({ status: "available" });
    const sessionId = await app.providers.startSession({
      providerId: providerId("generic-process-test"),
      projectId: project.id,
      cwd: rootPath
    });
    await app.providers.sendTurn({
      providerId: providerId("generic-process-test"),
      projectId: project.id,
      sessionId,
      instruction: "Run process adapter"
    });

    const events = await app.events.queryEvents();
    expect(events.some((event) => event.type === "agent.turn.delta")).toBe(true);
    expect(events.some((event) => event.type === "provider.rawEvent")).toBe(true);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("agent_ready");
  });
});

async function createProviderScript(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-provider-"));
  const scriptPath = path.join(dir, "provider.mjs");
  await writeFile(
    scriptPath,
    [
      "console.log(JSON.stringify({ type: 'agent.turn.delta', payload: { text: 'process event' } }));",
      "console.log('not-json');",
      "console.log(JSON.stringify({ type: 'agent.turn.completed', payload: { result: 'done' } }));"
    ].join("\n")
  );
  return scriptPath;
}
