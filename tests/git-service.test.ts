import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService } from "../src/git/GitService";

const execFileAsync = promisify(execFile);

describe("GitService", () => {
  it("classifies tracked, renamed, deleted, untracked, and binary diffs", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "praxis-git-diff-"));
    await git(rootPath, ["init"]);
    await git(rootPath, ["config", "user.email", "praxis@example.test"]);
    await git(rootPath, ["config", "user.name", "Praxis Test"]);
    await writeFile(path.join(rootPath, "modified.txt"), "before\n");
    await writeFile(path.join(rootPath, "deleted.txt"), "delete me\n");
    await writeFile(path.join(rootPath, "renamed-old.txt"), "rename me\n");
    await git(rootPath, ["add", "."]);
    await git(rootPath, ["commit", "-m", "initial"]);

    await writeFile(path.join(rootPath, "modified.txt"), "after\n");
    await rm(path.join(rootPath, "deleted.txt"));
    await git(rootPath, ["mv", "renamed-old.txt", "renamed-new.txt"]);
    await writeFile(path.join(rootPath, "created.txt"), "created\n");
    await git(rootPath, ["add", "created.txt"]);
    await writeFile(path.join(rootPath, "untracked.txt"), "untracked\n");
    await writeFile(path.join(rootPath, "assets.bin"), Buffer.from([0, 1, 2, 3]));

    const diffs = await new GitService().getDiff(rootPath);
    const byPath = new Map(diffs.map((diff) => [diff.path, diff]));

    expect(byPath.get("modified.txt")).toMatchObject({ changeKind: "modified", source: "git", binary: false });
    expect(byPath.get("modified.txt")?.diff).toContain("-before");
    expect(byPath.get("modified.txt")?.diff).toContain("+after");
    expect(byPath.get("deleted.txt")).toMatchObject({ changeKind: "deleted", source: "git" });
    expect(byPath.get("renamed-new.txt")).toMatchObject({
      changeKind: "renamed",
      oldPath: "renamed-old.txt",
      source: "git"
    });
    expect(byPath.get("created.txt")).toMatchObject({ changeKind: "created", source: "git", binary: false });
    expect(byPath.get("untracked.txt")).toMatchObject({ changeKind: "created", source: "untracked", binary: false });
    expect(byPath.get("untracked.txt")?.diff).toContain("new file mode");
    expect(byPath.get("assets.bin")).toMatchObject({
      changeKind: "created",
      source: "untracked",
      binary: true,
      diff: "Binary file metadata only.",
      sizeBytes: 4
    });
  });

  it("returns no diff files for non-git projects", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "praxis-no-git-"));
    await mkdir(path.join(rootPath, "src"));
    await writeFile(path.join(rootPath, "src", "example.ts"), "export const value = 1;\n");

    await expect(new GitService().getDiff(rootPath)).resolves.toEqual([]);
  });
});

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}
