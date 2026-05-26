import { CheckService } from "../checks/CheckService";
import type { ProviderId } from "../core";
import { GitService } from "../git/GitService";
import { AppEventLog } from "../events/AppEventLog";
import { InMemoryEventStore, type EventStore } from "../events/EventStore";
import { createDomainEvent } from "../events/eventFactory";
import { ObservabilityService } from "../observability/ObservabilityService";
import { PolicyService } from "../policies/PolicyService";
import { PluginRegistry } from "../plugins/PluginRegistry";
import { SettingsService, type SettingsRepository } from "../settings/SettingsService";
import { FakeProviderAdapter } from "../providers/fake/FakeProviderAdapter";
import type { FakeProviderScenarioName } from "../providers/fake/FakeProviderScenarios";
import type { ProviderAdapter } from "../providers/interface";
import { ProjectRegistryService } from "../projects/ProjectRegistryService";
import { ProviderRegistry } from "../app/ProviderRegistry";
import { ProviderService } from "../app/ProviderService";
import { AgentRunService, ArtifactService, ProjectWorkspaceService, WorkItemService } from "../app/ProjectWorkspaceService";

export type PraxisApp = Awaited<ReturnType<typeof createPraxisApp>>;

export async function createPraxisApp(
  input: { eventStore?: EventStore; fakeScenario?: FakeProviderScenarioName; providerAdapters?: ProviderAdapter[] } = {}
) {
  const eventStore: EventStore = input.eventStore ?? new InMemoryEventStore();
  const events = new AppEventLog(eventStore);
  await events.restore();
  const settings = new SettingsService(isSettingsRepository(eventStore) ? eventStore : undefined);

  const providerRegistry = new ProviderRegistry();
  const fakeProvider = new FakeProviderAdapter({ scenario: input.fakeScenario });
  providerRegistry.register(fakeProvider);
  const enabledProviderIds = settings.get().enabledProviderIds;
  for (const adapter of input.providerAdapters ?? []) {
    if (enabledProviderIds.length === 0 || enabledProviderIds.includes(adapter.id)) {
      providerRegistry.register(adapter);
    }
  }
  await appendDisabledProviderEvents(events, providerRegistry);

  const git = new GitService();
  const projects = new ProjectRegistryService(events, git, () => events.snapshot());
  const providers = new ProviderService(providerRegistry, events, () => events.snapshot(), git);
  const workspace = new ProjectWorkspaceService(events, () => events.snapshot());
  const workItems = new WorkItemService(events, () => events.snapshot());
  const artifacts = new ArtifactService(events, () => events.snapshot());
  const agentRuns = new AgentRunService(events, () => events.snapshot(), providers);
  const checks = new CheckService(events, () => events.snapshot());
  const policies = new PolicyService();
  const plugins = new PluginRegistry(events);
  const observability = new ObservabilityService(events, settings, policies, plugins, () => events.snapshot());

  await providers.registerAvailableProviders();

  return {
    events,
    eventStore,
    providerRegistry,
    fakeProvider,
    providers,
    workspace,
    workItems,
    artifacts,
    agentRuns,
    projects,
    git,
    checks,
    policies,
    observability,
    plugins,
    settings,
    snapshot: () => events.snapshot(),
    restore: () => events.restore(),
    replay: () => events.replay()
  };
}

async function appendDisabledProviderEvents(events: AppEventLog, providerRegistry: ProviderRegistry): Promise<void> {
  const activeProviderIds = new Set(providerRegistry.listAdapters().map((adapter) => adapter.id));
  const staleProviderIds = Object.keys(events.snapshot().providers).filter(
    (providerIdValue) => !activeProviderIds.has(providerIdValue as ProviderId)
  );
  if (staleProviderIds.length === 0) return;
  await events.appendMany(
    staleProviderIds.map((providerIdValue) =>
      createDomainEvent({
        type: "provider.disabled",
        providerId: providerIdValue as ProviderId,
        source: "system",
        payload: { reason: "Provider adapter is not enabled for this runtime." },
        evidence: [{ type: "provider", providerId: providerIdValue as ProviderId }]
      })
    )
  );
}

function isSettingsRepository(value: EventStore): value is EventStore & SettingsRepository {
  return (
    "readSetting" in value &&
    typeof value.readSetting === "function" &&
    "writeSetting" in value &&
    typeof value.writeSetting === "function"
  );
}
