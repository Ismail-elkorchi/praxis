import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkDefinitionId,
  defaultProjectSettings,
  projectId,
  type CheckDefinition,
  type Project,
  type ProjectId,
  type ProjectSettings,
  type ProviderId
} from "../core";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";
import type { GitService } from "../git/GitService";

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
      tags: [],
      settings: normalizeProjectSettings({ defaultProviderId: input.defaultProviderId }),
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const [gitSnapshot, checkDefinitions] = await Promise.all([
      this.git.getStatus(canonicalPath),
      detectCheckDefinitions(canonicalPath, project.id)
    ]);

    if (gitSnapshot.isRepo) {
      project.repo = { rootPath: canonicalPath };
      project.defaultBranch = gitSnapshot.baseBranch;
    }

    await this.events.appendMany([
      createDomainEvent({
        type: "project.registered",
        projectId: project.id,
        source: "user",
        payload: { project, checkDefinitions },
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
    patch: { name?: string; tags?: string[]; archived?: boolean; settings?: Partial<ProjectSettings> }
  ): Promise<Project> {
    const existing = this.getProject(projectId);
    if (!existing) {
      throw new Error("Project was not found.");
    }

    const project: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      tags: patch.tags ?? existing.tags,
      settings: normalizeProjectSettings({ ...existing.settings, ...patch.settings }),
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

  async refreshProject(projectId: ProjectId): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error("Project was not found.");
    }
    const gitSnapshot = await this.git.getStatus(project.canonicalPath);
    await this.events.append(
      createDomainEvent({
        type: "git.statusChanged",
        projectId,
        source: "git",
        payload: gitSnapshot,
        evidence: [{ type: "git", repoPath: project.canonicalPath, sha: gitSnapshot.headSha }]
      })
    );
  }

  listProjects(): Project[] {
    return Object.values(this.getSnapshot().projects).map((entry) => entry.project);
  }

  getProject(projectId: ProjectId): Project | undefined {
    return this.getSnapshot().projects[projectId]?.project;
  }
}

function normalizeProjectSettings(settings: Partial<ProjectSettings> | undefined): ProjectSettings {
  return {
    ...defaultProjectSettings,
    ...settings,
    defaultCheckIds: [...(settings?.defaultCheckIds ?? defaultProjectSettings.defaultCheckIds)]
  };
}

async function detectCheckDefinitions(rootPath: string, projectId: ProjectId): Promise<CheckDefinition[]> {
  const packageJsonPath = path.join(rootPath, "package.json");
  const content = await readFile(packageJsonPath, "utf8").catch(() => undefined);
  if (!content) return [];

  const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};
  const packageManager = await detectPackageManager(rootPath);
  return Object.keys(scripts)
    .filter((script) => ["test", "lint", "build", "check", "typecheck"].includes(script))
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
}

async function detectPackageManager(rootPath: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await exists(path.join(rootPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(rootPath, "yarn.lock"))) return "yarn";
  return "npm";
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}
