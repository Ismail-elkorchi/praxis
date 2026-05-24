import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRunId, type CheckDefinition, type CheckRun, type ProjectId } from "../core";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";

const execFileAsync = promisify(execFile);

export class CheckService {
  constructor(
    private readonly events: AppEventLog,
    private readonly getSnapshot: () => AppSnapshot
  ) {}

  listDefinitions(projectId: ProjectId): CheckDefinition[] {
    return this.getSnapshot().projects[projectId]?.checkDefinitions ?? [];
  }

  async runCheck(definition: CheckDefinition): Promise<CheckRun> {
    const started: CheckRun = {
      id: checkRunId(),
      checkId: definition.id,
      projectId: definition.projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      relatedFiles: relatedFiles(this.getSnapshot(), definition.projectId)
    };

    await this.events.append(
      createDomainEvent({
        type: "check.started",
        projectId: definition.projectId,
        source: "check",
        payload: started,
        evidence: [{ type: "check", runId: started.id, status: "running" }]
      })
    );

    try {
      const result = await execFileAsync(definition.command[0] ?? "", definition.command.slice(1), {
        cwd: definition.cwd,
        timeout: definition.timeoutMs,
        maxBuffer: 10 * 1024 * 1024
      });
      const completed: CheckRun = {
        ...started,
        status: "passed",
        completedAt: new Date().toISOString(),
        exitCode: 0,
        stdoutRef: result.stdout.slice(-4000),
        stderrRef: result.stderr.slice(-4000)
      };
      await this.events.append(
        createDomainEvent({
          type: "check.completed",
          projectId: definition.projectId,
          source: "check",
          payload: completed,
          evidence: [{ type: "check", runId: completed.id, status: completed.status }]
        })
      );
      return completed;
    } catch (error) {
      const failed: CheckRun = {
        ...started,
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code ?? 1) : 1,
        stdoutRef: String((error as { stdout?: unknown }).stdout ?? "").slice(-4000),
        stderrRef: String((error as { stderr?: unknown }).stderr ?? (error as Error).message).slice(-4000),
        outputSummary: String((error as { stderr?: unknown }).stderr ?? (error as Error).message).slice(0, 240)
      };
      await this.events.append(
        createDomainEvent({
          type: "check.failed",
          projectId: definition.projectId,
          source: "check",
          payload: failed,
          evidence: [{ type: "check", runId: failed.id, status: failed.status }]
        })
      );
      return failed;
    }
  }
}

function relatedFiles(snapshot: AppSnapshot, projectId: ProjectId): string[] {
  const project = snapshot.projects[projectId];
  if (!project) return [];
  return [
    ...project.fileChanges.map((change) => change.path),
    ...project.git.stagedFiles,
    ...project.git.unstagedFiles,
    ...project.git.untrackedFiles
  ];
}
