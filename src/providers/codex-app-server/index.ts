import { providerId } from "../../core";
import type { ProviderAdapter, ProviderDiscoveryContext } from "../interface";
import { defaultCodexCommand } from "./Compatibility";
import { CodexAppServerProviderAdapter } from "./CodexAppServerProviderAdapter";

export { CodexAppServerProviderAdapter } from "./CodexAppServerProviderAdapter";
export type { CodexAppServerProviderOptions } from "./CodexAppServerProviderAdapter";
export { codexFeatureMatrix } from "./FeatureMatrix";
export type { CodexFeatureClassification, CodexFeatureMatrixEntry } from "./FeatureMatrix";
export { checkCodexAppServerAvailability, schemaStrategy } from "./Compatibility";

export function createProviderAdapter(context: ProviderDiscoveryContext): ProviderAdapter {
  const id = providerId("codex-app-server");
  return new CodexAppServerProviderAdapter({
    id,
    command: context.commandOverrides[id] ?? context.env.CODEX_BIN ?? defaultCodexCommand,
    args: ["app-server", "--stdio"]
  });
}
