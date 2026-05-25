import type { ProviderAvailability, ProviderCapabilities, ProviderId } from "../../core";
import type { ProviderAdapter } from "./ProviderAdapter";

export type ProviderContractResult = {
  providerId: ProviderId;
  failures: string[];
};

export class ProviderContractError extends Error {
  constructor(readonly result: ProviderContractResult) {
    super(`Provider adapter contract failed for ${result.providerId}: ${result.failures.join("; ")}`);
    this.name = "ProviderContractError";
  }
}

export async function validateProviderAdapterContract(
  adapter: ProviderAdapter,
  input: { expectedId?: ProviderId } = {}
): Promise<ProviderContractResult> {
  const failures: string[] = [];
  if (!adapter.id) failures.push("id is required");
  if (input.expectedId && adapter.id !== input.expectedId) {
    failures.push("contribution id must match adapter id");
  }
  if (!adapter.kind) failures.push("kind is required");
  if (!adapter.displayName) failures.push("displayName is required");
  if (!adapter.adapterVersion) failures.push("adapterVersion is required");
  assertFunction(adapter.startSession, "startSession", failures);
  assertFunction(adapter.stopSession, "stopSession", failures);
  assertFunction(adapter.sendTurn, "sendTurn", failures);
  assertFunction(adapter.respondToApproval, "respondToApproval", failures);
  assertFunction(adapter.watchEvents, "watchEvents", failures);

  const capabilities = await readCapabilities(adapter, failures);
  if (capabilities) {
    validateCapabilities(capabilities, adapter, failures);
  }

  const availability = await readAvailability(adapter, failures);
  if (availability) {
    validateAvailability(availability, failures);
  }

  const result = { providerId: adapter.id, failures };
  if (failures.length > 0) {
    throw new ProviderContractError(result);
  }
  return result;
}

async function readCapabilities(adapter: ProviderAdapter, failures: string[]): Promise<ProviderCapabilities | undefined> {
  try {
    return await adapter.getCapabilities();
  } catch (error) {
    failures.push(`getCapabilities failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return undefined;
  }
}

async function readAvailability(adapter: ProviderAdapter, failures: string[]): Promise<ProviderAvailability | undefined> {
  try {
    return await adapter.checkAvailability();
  } catch (error) {
    failures.push(`checkAvailability failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return undefined;
  }
}

function validateCapabilities(
  capabilities: ProviderCapabilities,
  adapter: ProviderAdapter,
  failures: string[]
): void {
  for (const key of capabilityKeys) {
    if (typeof capabilities[key] !== "boolean") {
      failures.push(`capability ${key} must be boolean`);
    }
  }
  if (capabilities.canResumeSession) assertFunction(adapter.resumeSession, "resumeSession", failures);
  if (capabilities.canInterruptTurn) assertFunction(adapter.interruptTurn, "interruptTurn", failures);
  if (capabilities.canSteerTurn) assertFunction(adapter.steerTurn, "steerTurn", failures);
  if (capabilities.canImportExistingSessions) assertFunction(adapter.importSessions, "importSessions", failures);
  if (capabilities.canStreamEvents) assertFunction(adapter.watchEvents, "watchEvents", failures);
}

function validateAvailability(availability: ProviderAvailability, failures: string[]): void {
  if (!["available", "unavailable", "incompatible"].includes(availability.status)) {
    failures.push("availability status is invalid");
  }
  if (availability.status !== "available" && !availability.reason) {
    failures.push("unavailable and incompatible providers must include a reason");
  }
}

function assertFunction(value: unknown, name: string, failures: string[]): void {
  if (typeof value !== "function") {
    failures.push(`${name} is required`);
  }
}

const capabilityKeys = [
  "canStartSession",
  "canResumeSession",
  "canListSessions",
  "canImportExistingSessions",
  "canStreamEvents",
  "canStreamTokenDeltas",
  "canInterruptTurn",
  "canSteerTurn",
  "canRequestCommandApproval",
  "canRequestFileApproval",
  "canRunShellCommands",
  "canEditFiles",
  "canReportFileDiffs",
  "canReportTokenUsage",
  "canUseExternalTools",
  "supportsSandboxing",
  "supportsPermissionProfiles",
  "supportsStructuredProtocol"
] as const;
