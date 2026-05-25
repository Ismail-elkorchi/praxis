import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const coreFolders = [
  "src/core",
  "src/app",
  "src/dashboard",
  "src/events",
  "src/policies",
  "src/projects",
  "src/checks",
  "src/git",
  "src/runtime",
  "src/server",
  "src/ui",
  "src/plugins"
];
const providerSpecificTerms = ["openai", "anthropic", "gemini", "claude", "codex"];

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return listFiles(fullPath);
        }
        return Promise.resolve([fullPath]);
      })
    );
    return nested.flat().filter((file) => /\.(ts|tsx)$/.test(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("provider-neutral public core", () => {
  it("does not import provider-specific adapter folders from core-facing modules", async () => {
    const files = (await Promise.all(coreFolders.map((folder) => listFiles(path.join(root, folder))))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
      for (const line of importLines) {
        if (/providers\/(?!interface|discovery)/.test(line)) {
          violations.push(`${path.relative(root, file)}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not use runtime-provider names in core-facing source", async () => {
    const files = (await Promise.all(coreFolders.map((folder) => listFiles(path.join(root, folder))))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const term of providerSpecificTerms) {
        const pattern = new RegExp(`\\b${term}\\b`, "i");
        if (pattern.test(source)) {
          violations.push(`${path.relative(root, file)} contains ${term}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
