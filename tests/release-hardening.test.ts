import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { providerId, type ProviderCapabilities } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import type { ProviderAdapter } from "../src/providers/interface";
import { startPraxisRuntime } from "../src/runtime/PraxisRuntimeHost";
import { defaultAppSettings, SettingsService } from "../src/settings/SettingsService";
import { createTempProject } from "./helpers/tempProject";

const execFileAsync = promisify(execFile);

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

  it("starts and shuts down the local runtime with SQLite, fake provider, and local server", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-runtime-")), "praxis.sqlite");
    const runtime = await startPraxisRuntime({ databasePath, listen: true, port: 0 });

    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(runtime.startupSteps).toEqual(
      expect.arrayContaining([
        "open_database",
        "run_migrations",
        "load_settings",
        "register_fake_provider",
        "check_provider_availability",
        "restore_projections",
        "start_local_server",
        "start_ui"
      ])
    );
    expect(runtime.app.providerRegistry.listRealProviders()).toEqual([]);
    expect(runtime.app.projects.listProjects()).toEqual([]);
    expect(runtime.app.snapshot().dashboard.providerStatus[0]?.availability.status).toBe("available");

    await expect(runtime.shutdown()).resolves.toEqual(
      expect.arrayContaining(["stop_check_runs", "preserve_agent_sessions", "flush_event_store", "stop_local_server", "close_database"])
    );
  });

  it("starts when an optional provider is unavailable and restores dashboard after restart", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-runtime-restart-")), "praxis.sqlite");
    const first = await startPraxisRuntime({ databasePath, providerAdapters: [unavailableProviderAdapter()], listen: false });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await first.app.projects.registerProject({ rootPath });

    expect(first.app.snapshot().dashboard.providerStatus.some((provider) => provider.availability.status === "unavailable")).toBe(true);
    await first.shutdown();

    const second = await startPraxisRuntime({ databasePath, providerAdapters: [unavailableProviderAdapter()], listen: false });
    expect(second.app.snapshot().dashboard.projectCards.some((card) => card.projectId === project.id)).toBe(true);
    expect(second.app.snapshot().approvals.history).toEqual([]);
    await second.shutdown();
  });

  it("ships public fake-provider onboarding examples without private-surface terms", async () => {
    const root = process.cwd();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { files?: string[] };
    expect(packageJson.files).toContain("examples");

    const publicOnboardingFiles = ["README.md", "examples/README.md", "examples/fake-provider-workflow.ts"];
    const join = (...parts: string[]) => parts.join("");
    const deniedTerms = [
      join("tse-", "workbench"),
      join("projects/", "Praxis"),
      join("clusters", "/"),
      join("plans/", "provider-neutral-agent-control-plane-specs"),
      join("go", "als/"),
      join("public-private", ".tmp"),
      join("/home/", "ismail-el-korchi"),
      join("/", "goal")
    ];

    for (const file of publicOnboardingFiles) {
      const content = await readFile(path.join(root, file), "utf8");
      for (const term of deniedTerms) {
        expect(content, `${file} must not include ${term}`).not.toContain(term);
      }
    }

    const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const { stdout } = await execFileAsync(tsxBin, ["examples/fake-provider-workflow.ts"], {
      cwd: root,
      timeout: 15_000
    });
    const output = JSON.parse(stdout) as {
      providerStatuses: { name: string; status: string }[];
      realProviderCount: number;
      modeBeforeDecision: string;
      pendingApprovals: number;
      approvalHistory: { status: string }[];
      commandRuns?: { status: string; exitCode?: number }[];
      eventTypes: string[];
    };

    expect(output.providerStatuses).toEqual([{ name: "Fake provider", status: "available" }]);
    expect(output.realProviderCount).toBe(0);
    expect(output.modeBeforeDecision).toBe("approval_center");
    expect(output.pendingApprovals).toBe(0);
    expect(output.approvalHistory).toEqual([expect.objectContaining({ status: "accepted" })]);
    expect(output.commandRuns).toEqual([expect.objectContaining({ status: "completed", exitCode: 0 })]);
    expect(output.eventTypes).toEqual(expect.arrayContaining(["project.registered", "approval.requested", "approval.accepted"]));
  });
});

function unavailableProviderAdapter(): ProviderAdapter {
  const id = providerId("unavailable-test");
  const capabilities: ProviderCapabilities = {
    canStartSession: false,
    canResumeSession: false,
    canListSessions: false,
    canImportExistingSessions: false,
    canStreamEvents: false,
    canStreamTokenDeltas: false,
    canInterruptTurn: false,
    canSteerTurn: false,
    canRequestCommandApproval: false,
    canRequestFileApproval: false,
    canRunShellCommands: false,
    canEditFiles: false,
    canReportFileDiffs: false,
    canReportTokenUsage: false,
    canUseExternalTools: false,
    supportsSandboxing: false,
    supportsPermissionProfiles: false,
    supportsStructuredProtocol: false
  };

  return {
    id,
    kind: "test",
    displayName: "Unavailable test provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return capabilities;
    },
    async checkAvailability() {
      return { status: "unavailable" as const, reason: "Not configured." };
    },
    async startSession() {
      return { events: [] };
    },
    async stopSession() {},
    async sendTurn() {
      return { events: [] };
    },
    async respondToApproval() {},
    async *watchEvents() {}
  };
}
