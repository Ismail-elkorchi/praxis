import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRunId, type CheckDefinition, type CheckRun, type CheckRunId, type ProjectId } from "../core";
import { PraxisError } from "../app/errors";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";

const execFileAsync = promisify(execFile);

export class CheckService {
  private readonly cancelledRuns = new Set<CheckRunId>();

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

  async cancelRun(runId: CheckRunId): Promise<CheckRun> {
    this.cancelledRuns.add(runId);
    const run = Object.values(this.getSnapshot().projects)
      .flatMap((project) => project.checkRuns)
      .find((checkRun) => checkRun.id === runId);
    if (!run) {
      throw new Error("Check run was not found.");
    }
    const cancelled: CheckRun = {
      ...run,
      status: "cancelled",
      completedAt: new Date().toISOString()
    };
    await this.events.append(
      createDomainEvent({
        type: "check.cancelled",
        projectId: run.projectId,
        source: "check",
        payload: cancelled,
        evidence: [{ type: "check", runId: cancelled.id, status: cancelled.status }]
      })
    );
    return cancelled;
  }

  async waiveCheck(input: { projectId: ProjectId; checkId: CheckDefinition["id"]; reason?: string }): Promise<CheckRun> {
    const definition = this.listDefinitions(input.projectId).find((check) => check.id === input.checkId);
    if (!definition) {
      throw new PraxisError("not_found", "Check definition was not found.", { projectId: input.projectId, checkId: input.checkId });
    }
    const now = new Date().toISOString();
    const waived: CheckRun = {
      id: checkRunId(),
      checkId: definition.id,
      projectId: input.projectId,
      status: "waived",
      startedAt: now,
      completedAt: now,
      outputSummary: input.reason ?? "Waived by user.",
      waivedReason: input.reason,
      relatedFiles: relatedFiles(this.getSnapshot(), input.projectId)
    };

    await this.events.append(
      createDomainEvent({
        type: "check.waived",
        projectId: input.projectId,
        source: "user",
        payload: waived,
        evidence: [
          { type: "check", runId: waived.id, status: waived.status },
          { type: "user", commandId: "checks.waive" }
        ]
      })
    );
    return waived;
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
