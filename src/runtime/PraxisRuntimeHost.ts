import { AddressInfo } from "node:net";
import path from "node:path";
import type { FakeProviderScenarioName } from "../providers/fake/FakeProviderScenarios";
import type { ProviderAdapter } from "../providers/interface";
import { createPraxisApp, type PraxisApp } from "../composition/createPraxisApp";
import { SqliteEventStore } from "../events/SqliteEventStore";
import { defaultAppSettings } from "../settings/SettingsService";
import { createLocalServer } from "../server/createLocalServer";

export type RuntimeStartupStep =
  | "open_database"
  | "run_migrations"
  | "load_settings"
  | "load_provider_registry"
  | "register_fake_provider"
  | "discover_configured_providers"
  | "restore_projections"
  | "check_provider_availability"
  | "start_local_server"
  | "start_ui";

export type RuntimeShutdownStep =
  | "stop_check_runs"
  | "preserve_agent_sessions"
  | "flush_event_store"
  | "close_provider_clients"
  | "close_database"
  | "stop_local_server";

export type RuntimeDeploymentMode = "local_desktop" | "local_browser";

export type StartPraxisRuntimeOptions = {
  databasePath?: string;
  providerAdapters?: ProviderAdapter[];
  fakeScenario?: FakeProviderScenarioName;
  host?: string;
  port?: number;
  staticRoot?: string;
  listen?: boolean;
  deploymentMode?: RuntimeDeploymentMode;
};

export type PraxisRuntimeHost = {
  app: PraxisApp;
  startupSteps: RuntimeStartupStep[];
  shutdownSteps: RuntimeShutdownStep[];
  deploymentMode: RuntimeDeploymentMode;
  url?: string;
  shutdown(): Promise<RuntimeShutdownStep[]>;
};

export async function startPraxisRuntime(options: StartPraxisRuntimeOptions = {}): Promise<PraxisRuntimeHost> {
  const startupSteps: RuntimeStartupStep[] = [];
  const shutdownSteps: RuntimeShutdownStep[] = [];
  const deploymentMode = options.deploymentMode ?? "local_browser";
  const eventStore = new SqliteEventStore(options.databasePath ?? defaultAppSettings.databasePath);
  startupSteps.push("open_database", "run_migrations");

  const app = await createPraxisApp({
    eventStore,
    fakeScenario: options.fakeScenario,
    providerAdapters: options.providerAdapters
  });
  startupSteps.push(
    "load_settings",
    "load_provider_registry",
    "register_fake_provider",
    "discover_configured_providers",
    "restore_projections"
  );

  await app.providers.checkAvailability();
  startupSteps.push("check_provider_availability");

  const serverBundle = options.listen
    ? createLocalServer({ app, staticRoot: options.staticRoot ?? path.resolve("dist") })
    : undefined;
  let url: string | undefined;
  if (serverBundle) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 4187;
    await new Promise<void>((resolve) => serverBundle.server.listen(port, host, () => resolve()));
    const address = serverBundle.server.address() as AddressInfo;
    url = `http://${host}:${address.port}`;
    startupSteps.push("start_local_server", "start_ui");
  }

  return {
    app,
    startupSteps,
    shutdownSteps,
    deploymentMode,
    url,
    shutdown: async () => {
      shutdownSteps.push("stop_check_runs", "preserve_agent_sessions", "flush_event_store", "close_provider_clients");
      if (serverBundle) {
        serverBundle.sockets.close();
        await new Promise<void>((resolve) => serverBundle.server.close(() => resolve()));
        shutdownSteps.push("stop_local_server");
      }
      app.eventStore.close?.();
      shutdownSteps.push("close_database");
      return [...shutdownSteps];
    }
  };
}
