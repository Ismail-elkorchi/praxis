import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSnapshot } from "../core";

const execFileAsync = promisify(execFile);

export type DiffFileViewModel = {
  path: string;
  changeKind: "created" | "modified" | "deleted" | "renamed" | "binary";
  source: "git" | "untracked";
  diff: string;
  binary: boolean;
};

export class GitService {
  async getStatus(rootPath: string): Promise<GitSnapshot> {
    const isRepo = await this.isRepository(rootPath);
    if (!isRepo) {
      return {
        isRepo: false,
        dirty: false,
        ahead: 0,
        behind: 0,
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
        conflictedFiles: []
      };
    }

    const [branch, headSha, porcelain] = await Promise.all([
      git(rootPath, ["branch", "--show-current"]).then((result) => result.stdout.trim()).catch(() => undefined),
      git(rootPath, ["rev-parse", "HEAD"]).then((result) => result.stdout.trim()).catch(() => undefined),
      git(rootPath, ["status", "--porcelain=v1", "-z"]).then((result) => result.stdout)
    ]);

    const parsed = parsePorcelain(porcelain);
    return {
      isRepo: true,
      branch,
      headSha,
      dirty:
        parsed.stagedFiles.length +
          parsed.unstagedFiles.length +
          parsed.untrackedFiles.length +
          parsed.conflictedFiles.length >
        0,
      ahead: 0,
      behind: 0,
      stagedFiles: parsed.stagedFiles,
      unstagedFiles: parsed.unstagedFiles,
      untrackedFiles: parsed.untrackedFiles,
      conflictedFiles: parsed.conflictedFiles
    };
  }

  async getDiff(rootPath: string): Promise<DiffFileViewModel[]> {
    const status = await this.getStatus(rootPath);
    if (!status.isRepo) return [];

    const changed = [...status.stagedFiles, ...status.unstagedFiles];
    const diffs: DiffFileViewModel[] = [];
    for (const file of new Set(changed)) {
      const diff = await git(rootPath, ["diff", "--", file])
        .then((result) => result.stdout)
        .catch(() => "");
      diffs.push({
        path: file,
        changeKind: "modified",
        source: "git",
        diff,
        binary: diff.includes("Binary files")
      });
    }

    for (const file of status.untrackedFiles) {
      const fullPath = path.join(rootPath, file);
      const content = await readFile(fullPath).catch(() => Buffer.from(""));
      const binary = content.includes(0);
      diffs.push({
        path: file,
        changeKind: "created",
        source: "untracked",
        binary,
        diff: binary ? "Binary file metadata only." : untrackedDiff(file, content.toString("utf8"))
      });
    }

    return diffs;
  }

  async createWorktree(input: { rootPath: string; worktreePath: string; branch?: string }): Promise<{ path: string; branch?: string }> {
    await mkdir(path.dirname(input.worktreePath), { recursive: true });
    const args = ["worktree", "add"];
    if (input.branch) {
      args.push("-b", input.branch);
    }
    args.push(input.worktreePath);
    await git(input.rootPath, args);
    return { path: input.worktreePath, branch: input.branch };
  }

  private async isRepository(rootPath: string): Promise<boolean> {
    try {
      const result = await git(rootPath, ["rev-parse", "--is-inside-work-tree"]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

function parsePorcelain(output: string): Pick<
  GitSnapshot,
  "stagedFiles" | "unstagedFiles" | "untrackedFiles" | "conflictedFiles"
> {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const conflictedFiles: string[] = [];
  const entries = output.split("\0").filter(Boolean);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const status = entry.slice(0, 2);
    const file = entry.slice(3);

    if (status === "??") {
      untrackedFiles.push(file);
      continue;
    }
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status)) {
      conflictedFiles.push(file);
      continue;
    }
    if (status[0] !== " " && status[0] !== "?") stagedFiles.push(file);
    if (status[1] !== " " && status[1] !== "?") unstagedFiles.push(file);
    if (status[0] === "R" || status[0] === "C") {
      index += 1;
    }
  }

  return { stagedFiles, unstagedFiles, untrackedFiles, conflictedFiles };
}

function untrackedDiff(file: string, content: string): string {
  const lines = content.split("\n").map((line) => `+${line}`);
  return [`diff --git a/${file} b/${file}`, "new file mode 100644", "--- /dev/null", `+++ b/${file}`, ...lines].join(
    "\n"
  );
}
