import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import path from "node:path";
import { providerId, type AgentSession, type AgentTurn } from "../core";
import { createDomainEvent } from "../events/eventFactory";
import { CodexAppServerProviderAdapter } from "../providers/codex-app-server";
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
  | "recover_crashed_runtime"
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
  autoRegisterCodexAppServer?: boolean;
  codexCommand?: string;
  codexArgs?: string[];
  fakeScenario?: FakeProviderScenarioName;
  host?: string;
  port?: number;
  staticRoot?: string;
  listen?: boolean;
  deploymentMode?: RuntimeDeploymentMode;
};

export type RuntimeLifecycleRecord = {
  runtimeId: string;
  status: "starting" | "running" | "clean_shutdown";
  deploymentMode: RuntimeDeploymentMode;
  pid: number;
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string;
};

export type PraxisRuntimeHost = {
  app: PraxisApp;
  startupSteps: RuntimeStartupStep[];
  shutdownSteps: RuntimeShutdownStep[];
  deploymentMode: RuntimeDeploymentMode;
  url?: string;
  shutdown(): Promise<RuntimeShutdownStep[]>;
};

export const runtimeLifecycleSettingKey = "runtime:lifecycle";

export async function startPraxisRuntime(options: StartPraxisRuntimeOptions = {}): Promise<PraxisRuntimeHost> {
  const startupSteps: RuntimeStartupStep[] = [];
  const shutdownSteps: RuntimeShutdownStep[] = [];
  const deploymentMode = options.deploymentMode ?? "local_browser";
  const runtimeId = randomUUID();
  const runtimeStartedAt = new Date().toISOString();
  const eventStore = new SqliteEventStore(options.databasePath ?? defaultAppSettings.databasePath);
  const previousLifecycle = eventStore.readSetting<RuntimeLifecycleRecord>(runtimeLifecycleSettingKey);
  writeRuntimeLifecycle(eventStore, runtimeId, deploymentMode, "starting", runtimeStartedAt);
  startupSteps.push("open_database", "run_migrations");

  const app = await createPraxisApp({
    eventStore,
    fakeScenario: options.fakeScenario,
    providerAdapters: runtimeProviderAdapters(options)
  });
  startupSteps.push(
    "load_settings",
    "load_provider_registry",
    "register_fake_provider",
    "discover_configured_providers",
    "restore_projections"
  );

  if (previousLifecycle && previousLifecycle.status !== "clean_shutdown") {
    await recoverCrashedRuntime(app, previousLifecycle);
    startupSteps.push("recover_crashed_runtime");
  }

  await app.providers.checkAvailability();
  startupSteps.push("check_provider_availability");
  writeRuntimeLifecycle(eventStore, runtimeId, deploymentMode, "running", runtimeStartedAt);

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
      writeRuntimeLifecycle(eventStore, runtimeId, deploymentMode, "clean_shutdown", runtimeStartedAt);
      app.eventStore.close?.();
      shutdownSteps.push("close_database");
      return [...shutdownSteps];
    }
  };
}

function runtimeProviderAdapters(options: StartPraxisRuntimeOptions): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = [];
  if (options.autoRegisterCodexAppServer !== false) {
    adapters.push(
      new CodexAppServerProviderAdapter({
        id: providerId("codex-app-server"),
        command: options.codexCommand ?? process.env.CODEX_BIN ?? "codex",
        args: options.codexArgs ?? ["app-server", "--stdio"]
      })
    );
  }
  adapters.push(...(options.providerAdapters ?? []));
  return adapters;
}

function writeRuntimeLifecycle(
  eventStore: SqliteEventStore,
  runtimeId: string,
  deploymentMode: RuntimeDeploymentMode,
  status: RuntimeLifecycleRecord["status"],
  runtimeStartedAt: string
): void {
  const timestamp = new Date().toISOString();
  eventStore.writeSetting(runtimeLifecycleSettingKey, {
    runtimeId,
    status,
    deploymentMode,
    pid: process.pid,
    startedAt: runtimeStartedAt,
    updatedAt: timestamp,
    stoppedAt: status === "clean_shutdown" ? timestamp : undefined
  });
}

async function recoverCrashedRuntime(app: PraxisApp, previousLifecycle: RuntimeLifecycleRecord): Promise<void> {
  const events = Object.values(app.snapshot().projects).flatMap((project) => {
    return Object.values(project.sessions).flatMap((session) => recoveryEventsForSession(session, Object.values(project.turns), previousLifecycle));
  });

  if (events.length > 0) {
    await app.events.appendMany(events);
  }
}

function recoveryEventsForSession(
  session: AgentSession,
  turns: AgentTurn[],
  previousLifecycle: RuntimeLifecycleRecord
) {
  if (!sessionRequiresRecovery(session)) {
    return [];
  }

  const activeTurn = turns.find((turn) => turn.sessionId === session.id && turn.status === "in_progress");
  const payload = {
    reason: "Runtime recovered after an unclean shutdown.",
    previousRuntimeId: previousLifecycle.runtimeId,
    previousStatus: previousLifecycle.status,
    previousUpdatedAt: previousLifecycle.updatedAt
  };
  const interrupted = activeTurn
    ? [
        createDomainEvent({
          type: "agent.turn.interrupted",
          projectId: session.projectId,
          sessionId: session.id,
          turnId: activeTurn.id,
          providerId: session.providerId,
          source: "system",
          payload,
          evidence: [{ type: "provider" as const, providerId: session.providerId }]
        })
      ]
    : [];

  return [
    ...interrupted,
    createDomainEvent({
      type: "agent.session.stale",
      projectId: session.projectId,
      sessionId: session.id,
      providerId: session.providerId,
      source: "system",
      payload,
      evidence: [{ type: "provider", providerId: session.providerId }]
    })
  ];
}

function sessionRequiresRecovery(session: AgentSession): boolean {
  return session.state === "active" || session.state === "created" || session.state === "starting";
}
