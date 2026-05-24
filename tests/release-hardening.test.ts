import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import { defaultAppSettings, SettingsService } from "../src/settings/SettingsService";
import { createTempProject } from "./helpers/tempProject";

describe("release hardening", () => {
  it("keeps raw provider logs disabled by default and requires confirmation to enable them", () => {
    const settings = new SettingsService();

    expect(defaultAppSettings.rawProviderLogsEnabled).toBe(false);
    expect(settings.get().telemetryMode).toBe("local_only");
    expect(() => settings.update({ rawProviderLogsEnabled: true })).toThrow(/confirmation/);
  });

  it("loads app settings from SQLite on restart", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-settings-")), "praxis.sqlite");
    const first = await createPraxisApp({ eventStore: new SqliteEventStore(databasePath) });

    first.settings.update({
      telemetryMode: "off",
      projectRoots: ["/workspace/projects"],
      enabledProviderIds: [providerId("fake")]
    });
    first.eventStore.close?.();

    const secondStore = new SqliteEventStore(databasePath);
    const second = await createPraxisApp({ eventStore: secondStore });

    expect(second.settings.get()).toMatchObject({
      telemetryMode: "off",
      projectRoots: ["/workspace/projects"],
      enabledProviderIds: [providerId("fake")]
    });
    expect(secondStore.countRows("settings")).toBe(1);
    second.eventStore.close?.();
  });

  it("records provider unavailability without crashing the app", async () => {
    const app = await createPraxisApp({ fakeScenario: "unavailable_path" });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });

    await expect(
      app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath })
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("error");
    expect((await app.events.queryEvents()).some((event) => event.type === "provider.error")).toBe(true);
  });
});
