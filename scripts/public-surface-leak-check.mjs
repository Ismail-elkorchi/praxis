import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const join = (...parts) => parts.join("");
const denied = [
  join("tse-", "workbench"),
  join("projects/", "Praxis"),
  join("clusters", "/"),
  join("plans/", "provider-neutral-agent-control-plane-specs"),
  join("go", "als/"),
  join("public-private", ".tmp"),
  join("/home/", "ismail-el-korchi"),
  join("raw planning", "/spec pack"),
  join("raw spec", " pack"),
  join("/", "goal")
];
const ignoredDirs = new Set([".git", "node_modules", "dist", "coverage", "playwright-report", "test-results"]);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      if (ignoredDirs.has(entry.name)) {
        return [];
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath);
      }
      return [fullPath];
    })
  );
  return nested.flat();
}

const violations = [];

for (const file of await listFiles(root)) {
  const relative = path.relative(root, file);
  const content = await readFile(file, "utf8").catch(() => "");
  for (const term of denied) {
    if (content.includes(term)) {
      violations.push(`${relative}: ${term}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Public-surface leak check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Public-surface leak check passed.");
