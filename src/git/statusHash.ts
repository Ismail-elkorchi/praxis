import type { GitSnapshot } from "../core";

export function gitStatusHash(git: GitSnapshot): string {
  return JSON.stringify({
    branch: git.branch,
    headSha: git.headSha,
    dirty: git.dirty,
    ahead: git.ahead,
    behind: git.behind,
    stagedFiles: sorted(git.stagedFiles),
    unstagedFiles: sorted(git.unstagedFiles),
    untrackedFiles: sorted(git.untrackedFiles),
    conflictedFiles: sorted(git.conflictedFiles)
  });
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
