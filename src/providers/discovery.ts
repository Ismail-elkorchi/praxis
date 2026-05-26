import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderAdapter, ProviderAdapterFactory, ProviderDiscoveryContext } from "./interface";

export type BundledProviderDiscoveryOptions = {
  commandOverrides?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  providerRootUrl?: URL;
};

type ProviderAdapterModule = {
  createProviderAdapter?: ProviderAdapterFactory;
};

const providerDirectoriesWithoutRuntimeFactories = new Set(["fake", "interface"]);

export async function discoverBundledProviderAdapters(
  options: BundledProviderDiscoveryOptions = {}
): Promise<ProviderAdapter[]> {
  const providerRootPath = fileURLToPath(options.providerRootUrl ?? new URL("./", import.meta.url));
  const entries = await readdir(providerRootPath, { withFileTypes: true }).catch(() => []);
  const context: ProviderDiscoveryContext = {
    commandOverrides: { ...(options.commandOverrides ?? {}) },
    env: options.env ?? process.env
  };
  const adapters: ProviderAdapter[] = [];

  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    if (providerDirectoriesWithoutRuntimeFactories.has(entry.name)) continue;
    const indexPath = await firstExistingPath([
      path.join(providerRootPath, entry.name, "index.js"),
      path.join(providerRootPath, entry.name, "index.ts")
    ]);
    if (!indexPath) continue;
    const providerModule = (await import(pathToFileURL(indexPath).href)) as ProviderAdapterModule;
    const adapter = await providerModule.createProviderAdapter?.(context);
    if (adapter) adapters.push(adapter);
  }

  return adapters;
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function fileExists(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((entry) => entry.isFile())
    .catch(() => false);
}
