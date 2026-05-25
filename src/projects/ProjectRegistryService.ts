import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkDefinitionId,
  defaultProjectSettings,
  projectId,
  type CheckDefinition,
  type PackageManager,
  type Project,
  type ProjectId,
  type ProjectMetadataFile,
  type ProjectSettings,
  type ProjectScript,
  type ProjectWorktree,
  type ProviderId
} from "../core";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";
import type { GitService } from "../git/GitService";
import { gitStatusHash } from "../git/statusHash";
import { PraxisError } from "../app/errors";
import { isBroadPermissionProfileId } from "../policies/PolicyService";

export class ProjectRegistryService {
  constructor(
    private readonly events: AppEventLog,
    private readonly git: GitService,
    private readonly getSnapshot: () => AppSnapshot
  ) {}

  async registerProject(input: { rootPath: string; name?: string; defaultProviderId?: ProviderId }): Promise<Project> {
    const stats = await stat(input.rootPath);
    if (!stats.isDirectory()) {
      throw new Error("Project path must be a directory.");
    }

    const canonicalPath = await realpath(input.rootPath);
    const existing = Object.values(this.getSnapshot().projects).find(
      (project) => project.project.canonicalPath === canonicalPath && !project.project.archived
    );
    if (existing) {
      return existing.project;
    }

    const timestamp = new Date().toISOString();
    const project: Project = {
      id: projectId(),
      name: input.name ?? path.basename(canonicalPath),
      rootPath: input.rootPath,
      canonicalPath,
      scripts: [],
      metadataFiles: [],
      worktrees: [],
      tags: [],
      settings: normalizeProjectSettings({ defaultProviderId: input.defaultProviderId }),
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const [gitSnapshot, discovery] = await Promise.all([
      this.git.getStatus(canonicalPath),
      discoverProject(canonicalPath, project.id)
    ]);
    project.packageManager = discovery.packageManager;
    project.scripts = discovery.scripts;
    project.metadataFiles = discovery.metadataFiles;
    project.worktrees = discovery.worktrees;

    if (gitSnapshot.isRepo) {
      project.repo = { rootPath: canonicalPath };
      project.defaultBranch = gitSnapshot.baseBranch;
    }

    await this.events.appendMany([
      createDomainEvent({
        type: "project.registered",
        projectId: project.id,
        source: "user",
        payload: { project, checkDefinitions: discovery.checkDefinitions },
        evidence: []
      }),
      createDomainEvent({
        type: "git.statusChanged",
        projectId: project.id,
        source: "git",
        payload: gitSnapshot,
        evidence: [{ type: "git", repoPath: canonicalPath, sha: gitSnapshot.headSha }]
      })
    ]);

    return project;
  }

  async updateProject(
    projectId: ProjectId,
    patch: { name?: string; tags?: string[]; archived?: boolean; settings?: Partial<ProjectSettings> },
    options: { confirmBroadPermissionProfile?: boolean } = {}
  ): Promise<Project> {
    const existing = this.getProject(projectId);
    if (!existing) {
      throw new Error("Project was not found.");
    }

    const settings = normalizeProjectSettings({ ...existing.settings, ...patch.settings });
    if (
      settings.defaultPermissionProfileId !== existing.settings.defaultPermissionProfileId &&
      isBroadPermissionProfileId(settings.defaultPermissionProfileId) &&
      !options.confirmBroadPermissionProfile
    ) {
      throw new PraxisError("confirmation_required", "Broad permission profile changes require explicit confirmation.", {
        projectId,
        permissionProfileId: settings.defaultPermissionProfileId
      });
    }

    const project: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      tags: patch.tags ?? existing.tags,
      settings,
      archived: patch.archived ?? existing.archived,
      updatedAt: new Date().toISOString()
    };

    await this.events.append(
      createDomainEvent({
        type: "project.updated",
        projectId,
        source: "user",
        payload: { project },
        evidence: []
      })
    );

    return project;
  }

  async archiveProject(projectId: ProjectId): Promise<Project> {
    const project = await this.updateProject(projectId, { archived: true });
    await this.events.append(
      createDomainEvent({
        type: "project.archived",
        projectId,
        source: "user",
        payload: { project },
        evidence: []
      })
    );
    return project;
  }

  async markReadyToMerge(
    projectId: ProjectId,
    options: { confirmOutOfDateBranch?: boolean } = {}
  ): Promise<AppSnapshot["projects"][ProjectId]["reviewState"]> {
    const snapshot = this.getSnapshot();
    const project = snapshot.projects[projectId];
    if (!project) {
      throw new PraxisError("not_found", "Project was not found.", { projectId });
    }

    const reasons = reviewNotReadyReasons(project);
    if (reasons.length > 0) {
      throw new PraxisError("review_not_ready", "Project is not ready to mark as reviewed.", { projectId, reasons });
    }
    if (project.git.behind > 0 && !options.confirmOutOfDateBranch) {
      throw new PraxisError("confirmation_required", "Out-of-date branch review requires explicit confirmation.", {
        projectId,
        behind: project.git.behind
      });
    }

    const markedAt = new Date().toISOString();
    const statusHash = gitStatusHash(project.git);
    const acceptedOutOfDateBranch = project.git.behind > 0 && options.confirmOutOfDateBranch === true;
    const event = await this.events.append(
      createDomainEvent({
        type: "project.readyToMergeMarked",
        projectId,
        source: "user",
        payload: {
          projectId,
          markedAt,
          acceptedOutOfDateBranch,
          statusHash,
          git: {
            branch: project.git.branch,
            headSha: project.git.headSha,
            ahead: project.git.ahead,
            behind: project.git.behind,
            dirty: project.git.dirty
          }
        },
        evidence: [
          { type: "git", repoPath: project.project.canonicalPath, sha: project.git.headSha, statusHash },
          { type: "user", commandId: "projects.markReadyToMerge" }
        ]
      })
    );

    return {
      readyToMergeMarkedAt: markedAt,
      acceptedOutOfDateBranch,
      statusHash,
      evidence: event.evidence
    };
  }

  async refreshProject(projectId: ProjectId): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error("Project was not found.");
    }
    const gitSnapshot = await this.git.getStatus(project.canonicalPath);
    const discovery = await discoverProject(project.canonicalPath, projectId);
    const refreshedProject: Project = {
      ...project,
      packageManager: discovery.packageManager,
      scripts: discovery.scripts,
      metadataFiles: discovery.metadataFiles,
      worktrees: discovery.worktrees,
      repo: gitSnapshot.isRepo ? { rootPath: project.canonicalPath } : project.repo,
      defaultBranch: gitSnapshot.baseBranch ?? project.defaultBranch,
      updatedAt: new Date().toISOString()
    };
    await this.events.appendMany([
      createDomainEvent({
        type: "project.updated",
        projectId,
        source: "system",
        payload: { project: refreshedProject, checkDefinitions: discovery.checkDefinitions },
        evidence: []
      }),
      createDomainEvent({
        type: "check.definitionDetected",
        projectId,
        source: "system",
        payload: { checkDefinitions: discovery.checkDefinitions },
        evidence: []
      }),
      createDomainEvent({
        type: "git.statusChanged",
        projectId,
        source: "git",
        payload: gitSnapshot,
        evidence: [{ type: "git", repoPath: project.canonicalPath, sha: gitSnapshot.headSha }]
      })
    ]);
  }

  listProjects(): Project[] {
    return Object.values(this.getSnapshot().projects).map((entry) => entry.project);
  }

  getProject(projectId: ProjectId): Project | undefined {
    return this.getSnapshot().projects[projectId]?.project;
  }
}

function reviewNotReadyReasons(project: AppSnapshot["projects"][ProjectId]): string[] {
  const reasons: string[] = [];
  if (!project.git.isRepo) reasons.push("not_git_repository");
  if (!project.git.dirty) reasons.push("no_git_changes");
  if (project.git.conflictedFiles.length > 0) reasons.push("has_conflicts");
  if (project.approvals.some((approval) => approval.status === "pending")) reasons.push("pending_approvals");
  if (Object.values(project.turns).some((turn) => turn.status === "in_progress")) reasons.push("active_turn");
  if (!requiredChecksGreen(project)) reasons.push("required_checks_not_green");
  return reasons;
}

function requiredChecksGreen(project: AppSnapshot["projects"][ProjectId]): boolean {
  const required = project.checkDefinitions.filter((definition) => definition.required);
  if (required.length === 0) return true;
  return required.every((definition) => {
    const latest = project.checkRuns
      .filter((run) => run.checkId === definition.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    return latest?.status === "passed";
  });
}

function normalizeProjectSettings(settings: Partial<ProjectSettings> | undefined): ProjectSettings {
  return {
    ...defaultProjectSettings,
    ...settings,
    defaultCheckIds: [...(settings?.defaultCheckIds ?? defaultProjectSettings.defaultCheckIds)]
  };
}

type ProjectDiscovery = {
  packageManager: PackageManager;
  scripts: ProjectScript[];
  metadataFiles: ProjectMetadataFile[];
  worktrees: ProjectWorktree[];
  checkDefinitions: CheckDefinition[];
};

async function discoverProject(rootPath: string, projectId: ProjectId): Promise<ProjectDiscovery> {
  const packageJsonPath = path.join(rootPath, "package.json");
  const content = await readFile(packageJsonPath, "utf8").catch(() => undefined);
  const packageManager = await detectPackageManager(rootPath);
  const metadataFiles = await detectMetadataFiles(rootPath);
  const worktrees = await detectWorktrees(rootPath);
  if (!content) {
    return { packageManager, scripts: [], metadataFiles, worktrees, checkDefinitions: [] };
  }

  const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};
  const projectScripts = Object.keys(scripts)
    .sort((left, right) => left.localeCompare(right))
    .map((script) => ({
      name: script,
      command: packageManager === "yarn" ? ["yarn", script] : [packageManager, "run", script],
      source: "package_json" as const,
      confidence: "high" as const
    }));
  const checkDefinitions = Object.keys(scripts)
    .filter((script) => ["test", "lint", "build", "check", "typecheck"].includes(script))
    .sort((left, right) => left.localeCompare(right))
    .map((script) => ({
      id: checkDefinitionId(),
      projectId,
      name: script,
      command: packageManager === "yarn" ? ["yarn", script] : [packageManager, "run", script],
      cwd: rootPath,
      timeoutMs: 120_000,
      required: script === "test" || script === "check" || script === "typecheck",
      source: "detected" as const
    }));
  return { packageManager, scripts: projectScripts, metadataFiles, worktrees, checkDefinitions };
}

async function detectPackageManager(rootPath: string): Promise<PackageManager> {
  if (await exists(path.join(rootPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(rootPath, "yarn.lock"))) return "yarn";
  if (await exists(path.join(rootPath, "bun.lockb"))) return "bun";
  if (await exists(path.join(rootPath, "package-lock.json"))) return "npm";
  if (await exists(path.join(rootPath, "package.json"))) return "npm";
  return "unknown";
}

async function detectMetadataFiles(rootPath: string): Promise<ProjectMetadataFile[]> {
  const candidates: ProjectMetadataFile[] = [
    { path: "package.json", kind: "package" },
    { path: "pnpm-workspace.yaml", kind: "workspace" },
    { path: "workspace.json", kind: "workspace" },
    { path: "praxis.json", kind: "project_config" },
    { path: ".praxis/project.json", kind: "project_config" }
  ];
  const existing: ProjectMetadataFile[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(rootPath, candidate.path))) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function detectWorktrees(rootPath: string): Promise<ProjectWorktree[]> {
  const gitFile = await readFile(path.join(rootPath, ".git"), "utf8").catch(() => undefined);
  if (!gitFile?.startsWith("gitdir:")) return [];
  const gitDir = gitFile.replace(/^gitdir:\s*/, "").trim();
  return [{ path: rootPath, branch: path.basename(path.dirname(gitDir)) }];
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}
