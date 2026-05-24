import type { AgentProvider, ProviderAvailability, ProviderCapabilities, ProviderId } from "../core";
import type { ProviderAdapter } from "../providers/interface";

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  unregister(providerId: ProviderId): void {
    this.adapters.delete(providerId);
  }

  get(providerId: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  listAdapters(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  listRealProviders(): ProviderAdapter[] {
    return this.listAdapters().filter((adapter) => adapter.kind !== "fake");
  }

  async listProviders(): Promise<AgentProvider[]> {
    return Promise.all(this.listAdapters().map(adapterToProvider));
  }
}

async function adapterToProvider(adapter: ProviderAdapter): Promise<AgentProvider> {
  let capabilities: ProviderCapabilities;
  let availability: ProviderAvailability;

  try {
    capabilities = await adapter.getCapabilities();
  } catch {
    capabilities = unavailableCapabilities();
  }

  try {
    availability = await adapter.checkAvailability();
  } catch (error) {
    availability = { status: "unavailable", reason: error instanceof Error ? error.message : "Unavailable" };
  }

  return {
    id: adapter.id,
    kind: adapter.kind,
    displayName: adapter.displayName,
    adapterVersion: adapter.adapterVersion,
    capabilities,
    availability
  };
}

export function unavailableCapabilities(): ProviderCapabilities {
  return {
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
}
