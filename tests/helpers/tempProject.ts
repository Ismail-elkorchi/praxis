import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTempProject(input: { git?: boolean; failingTest?: boolean; packageJson?: boolean } = {}) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "praxis-project-"));
  if (input.packageJson !== false) {
    await writeFile(
      path.join(rootPath, "package.json"),
      JSON.stringify(
        {
          scripts: {
            test: input.failingTest ? "node -e \"process.exit(1)\"" : "node -e \"process.exit(0)\"",
            typecheck: "node -e \"process.exit(0)\""
          }
        },
        null,
        2
      )
    );
  }

  if (input.git) {
    await execFileAsync("git", ["init"], { cwd: rootPath });
    await execFileAsync("git", ["config", "user.email", "praxis@example.test"], { cwd: rootPath });
    await execFileAsync("git", ["config", "user.name", "Praxis Test"], { cwd: rootPath });
    await execFileAsync("git", ["add", "."], { cwd: rootPath });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: rootPath });
  }

  return rootPath;
}
