import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProviderAvailability } from "../../core";

const execFileAsync = promisify(execFile);

export type CodexCompatibilityOptions = {
  command?: string;
  minimumVersion?: string;
  timeoutMs?: number;
};

export type CodexSchemaStrategy = {
  typescriptCommand: string[];
  jsonSchemaCommand: string[];
};

export const defaultCodexCommand = "codex";
export const defaultMinimumVersion = "0.1.0";

export async function checkCodexAppServerAvailability(
  options: CodexCompatibilityOptions = {}
): Promise<ProviderAvailability> {
  const command = options.command ?? defaultCodexCommand;
  const minimumVersion = options.minimumVersion ?? defaultMinimumVersion;
  if (!(await executableIsAvailable(command))) {
    return {
      status: "unavailable",
      reason: "Codex app-server command is not available.",
      details: codexSetupDetails(command)
    };
  }

  try {
    const result = await execFileAsync(command, ["--version"], { timeout: options.timeoutMs ?? 5_000 });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return {
        status: "incompatible",
        reason: "Codex app-server version could not be detected.",
        supportedVersions: `>=${minimumVersion}`,
        details: codexSetupDetails(command)
      };
    }
    if (compareVersions(version, minimumVersion) < 0) {
      return {
        status: "incompatible",
        version,
        reason: `Codex app-server ${version} is older than the supported minimum ${minimumVersion}.`,
        supportedVersions: `>=${minimumVersion}`,
        details: codexSetupDetails(command)
      };
    }
    return {
      status: "available",
      version,
      details: codexSetupDetails(command)
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Codex app-server version check failed.",
      details: codexSetupDetails(command)
    };
  }
}

export function schemaStrategy(command = defaultCodexCommand): CodexSchemaStrategy {
  return {
    typescriptCommand: [command, "app-server", "generate-ts"],
    jsonSchemaCommand: [command, "app-server", "generate-json-schema"]
  };
}

function codexSetupDetails(command: string): Record<string, unknown> {
  return {
    command,
    launchCommand: [command, "app-server", "--stdio"],
    versionCommand: [command, "--version"],
    environmentOverrides: [
      {
        name: "CODEX_BIN",
        description: "Set before starting Praxis to point at a non-default Codex binary."
      }
    ],
    setupSteps: [
      "Install the Codex command or make it available on PATH.",
      `Run ${command} --version to confirm the binary is reachable.`,
      `Restart Praxis so it can launch ${command} app-server --stdio.`,
      "Return to Settings and run Check availability."
    ],
    schemaStrategy: schemaStrategy(command)
  };
}

export function parseVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function executableIsAvailable(executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    return access(executable)
      .then(() => true)
      .catch(() => false);
  }
  return true;
}

function numericParts(version: string): number[] {
  return version
    .split(/[-+]/)[0]!
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}
