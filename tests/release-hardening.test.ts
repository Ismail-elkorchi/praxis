import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { defaultAppSettings, SettingsService } from "../src/settings/SettingsService";
import { createTempProject } from "./helpers/tempProject";

describe("release hardening", () => {
  it("keeps raw provider logs disabled by default and requires confirmation to enable them", () => {
    const settings = new SettingsService();

    expect(defaultAppSettings.rawProviderLogsEnabled).toBe(false);
    expect(settings.get().telemetryMode).toBe("local_only");
    expect(() => settings.update({ rawProviderLogsEnabled: true })).toThrow(/confirmation/);
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
