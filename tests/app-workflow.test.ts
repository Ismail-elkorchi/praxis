import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTurnId,
  approvalRequestId,
  providerId,
  type AgentSessionId,
  type ApprovalRequest,
  type DomainEvent,
  type ProviderCapabilities
} from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createDomainEvent } from "../src/events/eventFactory";
import { fakeProviderCapabilities } from "../src/providers/fake/FakeProviderAdapter";
import type { ProviderAdapter } from "../src/providers/interface";
import { createTempProject } from "./helpers/tempProject";

describe("provider-neutral application workflow", () => {
  it("starts with the fake provider and no real providers", async () => {
    const app = await createPraxisApp();

    expect(app.providerRegistry.listRealProviders()).toEqual([]);
    expect(app.snapshot().dashboard.providerStatus).toHaveLength(1);
    expect(app.snapshot().dashboard.providerStatus[0]?.availability.status).toBe("available");
  });

  it("registers and deduplicates a project by canonical path", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true });

    const first = await app.projects.registerProject({ rootPath });
    const second = await app.projects.registerProject({ rootPath: path.join(rootPath, ".") });

    expect(second.id).toBe(first.id);
    expect(app.snapshot().dashboard.projectCards).toHaveLength(1);
    expect(app.snapshot().projects[first.id]?.git.isRepo).toBe(true);
    expect(first.packageManager).toBe("npm");
    expect(first.metadataFiles).toContainEqual({ path: "package.json", kind: "package" });
    expect(first.scripts.map((script) => script.name)).toEqual(["test", "typecheck"]);
    expect(app.snapshot().projects[first.id]?.checkDefinitions.map((check) => check.name)).toContain("test");
  });

  it("uses focused project state and multiple active turns for dashboard mode priority", async () => {
    const app = await createPraxisApp();
    const firstRoot = await createTempProject({ packageJson: false });
    const secondRoot = await createTempProject({ packageJson: false });
    const first = await app.projects.registerProject({ rootPath: firstRoot, name: "Focused project" });
    const second = await app.projects.registerProject({ rootPath: secondRoot, name: "Parallel project" });
    const firstSession = await app.providers.startSession({ providerId: providerId("fake"), projectId: first.id, cwd: firstRoot });
    const secondSession = await app.providers.startSession({ providerId: providerId("fake"), projectId: second.id, cwd: secondRoot });

    await app.events.append(
      createDomainEvent({
        type: "dashboard.projectFocused",
        projectId: first.id,
        source: "user",
        payload: { projectId: first.id },
        evidence: [{ type: "user", commandId: "dashboard.focusProject" }]
      })
    );

    expect(app.snapshot().dashboard.mode).toBe("single_project_focus");
    expect(app.snapshot().dashboard.focusedProjectId).toBe(first.id);

    const firstTurnId = agentTurnId();
    await app.events.append(
      createDomainEvent({
        type: "agent.turn.started",
        projectId: first.id,
        sessionId: firstSession,
        turnId: firstTurnId,
        providerId: providerId("fake"),
        source: "provider",
        payload: { inputSummary: "Keep one focused turn visible" },
        evidence: []
      })
    );

    expect(app.snapshot().activeTurns).toHaveLength(1);
    expect(app.snapshot().dashboard.mode).toBe("single_project_focus");

    await app.events.append(
      createDomainEvent({
        type: "agent.turn.started",
        projectId: second.id,
        sessionId: secondSession,
        turnId: agentTurnId(),
        providerId: providerId("fake"),
        source: "provider",
        payload: { inputSummary: "Run another active turn" },
        evidence: []
      })
    );

    expect(app.snapshot().activeTurns).toHaveLength(2);
    expect(app.snapshot().dashboard.mode).toBe("active_work");
    expect(app.snapshot().dashboard.explanation.propositions).toContainEqual(
      expect.objectContaining({ predicate: "selected_mode", value: "true" })
    );
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("runs the approval path and stores the decision before provider continuation events", async () => {
    const app = await createPraxisApp({ fakeScenario: "approval_path" });
    const rootPath = await createTempProject({ git: true });
    const project = await app.projects.registerProject({ rootPath });

    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath,
      goal: "Exercise approval flow"
    });
    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Run the check"
    });

    expect(app.snapshot().dashboard.mode).toBe("approval_center");
    expect(app.snapshot().approvals.pending).toHaveLength(1);

    const approval = app.snapshot().approvals.pending[0];
    expect(approval).toBeDefined();
    await app.providers.decideApproval({
      providerId: providerId("fake"),
      approvalId: approval.id,
      decision: "accept_once"
    });

    const events = await app.events.queryEvents();
    const decisionIndex = events.findIndex((event) => event.type === "approval.accepted");
    const continuationIndex = events.findIndex((event) => event.type === "agent.command.started");
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeGreaterThan(decisionIndex);
    expect(app.snapshot().projects[project.id]?.commandRuns).toEqual([
      expect.objectContaining({
        command: ["npm", "test"],
        status: "completed",
        exitCode: 0,
        sessionId,
        turnId: expect.any(String)
      })
    ]);
    await expect(app.replay()).resolves.toEqual(app.snapshot());
    expect(app.snapshot().approvals.pending).toHaveLength(0);
    expect(app.snapshot().approvals.history[0]?.status).toBe("accepted");
  });

  it("does not silently retry declined approvals", async () => {
    const app = await createPraxisApp({ fakeScenario: "approval_path" });
    const rootPath = await createTempProject({ git: true });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath,
      goal: "Decline approval"
    });
    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Run the check"
    });
    const approval = app.snapshot().approvals.pending[0]!;

    await app.providers.decideApproval({ providerId: providerId("fake"), approvalId: approval.id, decision: "decline" });

    const events = await app.events.queryEvents();
    const declinedIndex = events.findIndex((event) => event.type === "approval.declined");
    const failedIndex = events.findIndex((event) => event.type === "agent.turn.failed");
    expect(declinedIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeGreaterThan(declinedIndex);
    expect(events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
    expect(app.snapshot().approvals.pending).toHaveLength(0);
    expect(app.snapshot().approvals.history[0]).toMatchObject({ id: approval.id, status: "declined" });
    expect(app.snapshot().projects[project.id]?.commandRuns).toEqual([]);
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("keeps a global approval queue across projects", async () => {
    const app = await createPraxisApp({ fakeScenario: "approval_path" });
    const firstRoot = await createTempProject({ packageJson: false });
    const secondRoot = await createTempProject({ packageJson: false });
    const first = await app.projects.registerProject({ rootPath: firstRoot, name: "First project" });
    const second = await app.projects.registerProject({ rootPath: secondRoot, name: "Second project" });
    const firstSession = await app.providers.startSession({ providerId: providerId("fake"), projectId: first.id, cwd: firstRoot });
    const secondSession = await app.providers.startSession({ providerId: providerId("fake"), projectId: second.id, cwd: secondRoot });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: first.id, sessionId: firstSession, instruction: "Approve one" });
    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: second.id, sessionId: secondSession, instruction: "Approve two" });

    expect(app.snapshot().approvals.pending).toHaveLength(2);
    expect(app.snapshot().dashboard.approvals.map((approval) => approval.projectTitle)).toEqual(
      expect.arrayContaining(["First project", "Second project"])
    );
    expect(app.snapshot().dashboard.mode).toBe("approval_center");
  });

  it("hides session-scoped approval decisions when provider capabilities do not allow them", async () => {
    const limitedProvider = sessionApprovalLimitedProvider();
    const app = await createPraxisApp({ providerAdapters: [limitedProvider], fakeScenario: "happy_path" });
    const rootPath = await createTempProject({ git: true });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: limitedProvider.id,
      projectId: project.id,
      cwd: rootPath,
      goal: "Request approval"
    });

    await app.providers.sendTurn({
      providerId: limitedProvider.id,
      projectId: project.id,
      sessionId,
      instruction: "Run a project command"
    });

    const approval = app.snapshot().dashboard.approvals[0];
    expect(approval?.decisionOptions.map((option) => option.decision)).toEqual(["accept_once", "decline", "cancel"]);
    expect(approval?.riskSignals).toEqual(["runs_package_script"]);
  });

  it("keeps non-git fake file changes out of git-based review states", async () => {
    const app = await createPraxisApp({ fakeScenario: "file_change_path" });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath
    });

    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Edit a file"
    });
    const approval = app.snapshot().approvals.pending[0];
    await app.providers.decideApproval({ providerId: providerId("fake"), approvalId: approval.id, decision: "accept_once" });

    expect(app.snapshot().projects[project.id]?.fileChanges.some((change) => change.status === "applied")).toBe(true);
    expect(app.snapshot().projects[project.id]?.git.isRepo).toBe(false);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("agent_ready");
    expect(app.snapshot().dashboard.mode).toBe("portfolio");
    await expect(app.projects.markReadyToMerge(project.id)).rejects.toMatchObject({
      code: "review_not_ready",
      details: { reasons: expect.arrayContaining(["not_git_repository", "no_git_changes"]) }
    });
  });

  it("blocks git review readiness while approvals are pending", async () => {
    const app = await createPraxisApp({ fakeScenario: "file_change_path" });
    const rootPath = await createTempProject({ git: true, packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath
    });

    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Propose a file change"
    });
    await writeFile(path.join(rootPath, "pending-change.ts"), "export const pending = true;\n");
    await app.projects.refreshProject(project.id);

    expect(app.snapshot().projects[project.id]?.git.dirty).toBe(true);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("waiting_for_approval");
    expect(app.snapshot().dashboard.mode).toBe("approval_center");
    expect(app.snapshot().dashboard.projectCards.find((card) => card.projectId === project.id)?.primaryAction).toMatchObject({
      id: "open-approvals",
      method: "agents.respondToApproval"
    });
  });

  it("makes git-backed fake file changes reviewable when checks are not required", async () => {
    const app = await createPraxisApp({ fakeScenario: "file_change_path" });
    const rootPath = await createTempProject({ git: true, packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath
    });

    await app.providers.sendTurn({
      providerId: providerId("fake"),
      projectId: project.id,
      sessionId,
      instruction: "Edit a file"
    });
    const approval = app.snapshot().approvals.pending[0];
    await app.providers.decideApproval({ providerId: providerId("fake"), approvalId: approval.id, decision: "accept_once" });
    await writeFile(path.join(rootPath, "src-example.ts"), "export const value = 1;\n");
    await app.projects.refreshProject(project.id);

    expect(app.snapshot().projects[project.id]?.fileChanges.some((change) => change.status === "applied")).toBe(true);
    expect(app.snapshot().projects[project.id]?.git.dirty).toBe(true);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("ready_for_review");
    expect(app.snapshot().dashboard.mode).toBe("diff_review");

    const reviewState = await app.projects.markReadyToMerge(project.id);
    expect(reviewState).toMatchObject({ acceptedOutOfDateBranch: false, statusHash: expect.any(String) });
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("ready_to_merge");
    expect(app.snapshot().dashboard.mode).toBe("diff_review");
    expect(app.snapshot().dashboard.projectCards.find((card) => card.projectId === project.id)?.primaryAction).toMatchObject({
      id: "review-diff",
      method: "git.openDiff"
    });
    expect(app.snapshot().dashboard.explanation.propositions).toContainEqual(
      expect.objectContaining({ predicate: "ready_to_merge", value: "true" })
    );

    await writeFile(path.join(rootPath, "another-change.ts"), "export const another = 2;\n");
    await app.projects.refreshProject(project.id);
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("ready_for_review");
  });

  it("requires confirmation before marking an out-of-date branch ready to merge", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true, packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    await writeFile(path.join(rootPath, "behind-change.ts"), "export const value = 1;\n");
    await app.projects.refreshProject(project.id);
    const git = app.snapshot().projects[project.id]!.git;
    await app.events.append(
      createDomainEvent({
        type: "git.statusChanged",
        projectId: project.id,
        source: "git",
        payload: { ...git, behind: 2 },
        evidence: [{ type: "git", repoPath: rootPath, sha: git.headSha }]
      })
    );

    await expect(app.projects.markReadyToMerge(project.id)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(app.projects.markReadyToMerge(project.id, { confirmOutOfDateBranch: true })).resolves.toMatchObject({
      acceptedOutOfDateBranch: true
    });
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("ready_to_merge");
  });

  it("uses the selected provider capability when deriving project card actions", async () => {
    const provider = noStartProvider();
    const app = await createPraxisApp({ providerAdapters: [provider] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath, defaultProviderId: provider.id });

    expect(app.snapshot().dashboard.projectCards.find((card) => card.projectId === project.id)).toMatchObject({
      providerLabel: "No-start provider",
      primaryAction: {
        method: "agents.startSession",
        disabled: true
      }
    });
  });

  it("imports provider sessions only when the selected provider supports import", async () => {
    const provider = sessionImportProvider();
    const app = await createPraxisApp({ providerAdapters: [provider] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath, defaultProviderId: provider.id });

    expect(app.snapshot().dashboard.projectCards.find((card) => card.projectId === project.id)?.secondaryActions).toContainEqual(
      expect.objectContaining({ id: "import-sessions", method: "agents.importSessions" })
    );
    await expect(app.providers.importSessions({ providerId: providerId("fake"), projectId: project.id })).rejects.toMatchObject({
      code: "capability_unavailable"
    });

    const result = await app.providers.importSessions({ providerId: provider.id, projectId: project.id });
    expect(result.importedSessionIds).toHaveLength(1);
    expect(result.importedSessionIds[0]).not.toBe("provider-session-1");
    const importedSession = app.snapshot().projects[project.id]?.sessions[result.importedSessionIds[0]!];
    expect(importedSession).toMatchObject({
      providerId: provider.id,
      providerSessionRef: {
        providerId: provider.id,
        externalId: "provider-session-1"
      }
    });
    expect((await app.events.queryEvents({ type: "agent.session.started" })).some((event) => event.source === "system")).toBe(true);
  });

  it("starts agent sessions in task-isolated worktrees when the project enables that mode", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true, packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    await app.projects.updateProject(project.id, { settings: { preferredWorktreeMode: "task_isolated" } });

    const sessionId = await app.providers.startSession({
      providerId: providerId("fake"),
      projectId: project.id,
      cwd: rootPath,
      goal: "Use isolated worktree"
    });

    const session = app.snapshot().projects[project.id]?.sessions[sessionId];
    const createdWorktree = (await app.events.queryEvents({ type: "git.worktree.created" }))[0];
    expect(createdWorktree).toBeDefined();
    expect(session?.cwd).not.toBe(rootPath);
    expect(session?.cwd).toBe((createdWorktree?.payload as { path?: string }).path);
    expect(app.snapshot().projects[project.id]?.project.worktrees).toContainEqual(
      expect.objectContaining({ path: session?.cwd, branch: expect.stringContaining("praxis/") })
    );
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("marks stale sessions on provider disconnect", async () => {
    const app = await createPraxisApp({ fakeScenario: "stale_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Continue" });

    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("stale");
    expect(app.snapshot().dashboard.mode).toBe("stale_sessions");
    expect(app.snapshot().dashboard.projectCards.find((card) => card.projectId === project.id)).toMatchObject({
      primaryAction: { id: "resume-session", method: "agents.resumeSession" },
      secondaryActions: expect.arrayContaining([expect.objectContaining({ id: "stop-session", method: "agents.stopSession" })])
    });
  });

  it("normalizes thrown provider turn crashes into stale sessions", async () => {
    const crashingProvider = throwingTurnProvider();
    const app = await createPraxisApp({ providerAdapters: [crashingProvider] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: crashingProvider.id, projectId: project.id, cwd: rootPath });

    const turnId = await app.providers.sendTurn({
      providerId: crashingProvider.id,
      projectId: project.id,
      sessionId,
      instruction: "Trigger provider crash"
    });

    const events = await app.events.queryEvents({ providerId: crashingProvider.id });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["provider.error", "agent.turn.failed", "agent.session.stale"])
    );
    expect(app.snapshot().projects[project.id]?.turns[turnId]?.status).toBe("failed");
    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.state).toBe("stale_or_disconnected");
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("stale");
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("records user input before provider continuation events", async () => {
    const app = await createPraxisApp({ fakeScenario: "user_input_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    const turnId = await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Ask" });

    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.state).toBe("waiting_for_user_input");
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("waiting_for_user_input");
    expect((await app.events.queryEvents()).map((event) => event.type)).toContain("agent.userInput.requested");

    await app.providers.respondToUserInput({ providerId: providerId("fake"), sessionId, turnId, input: "Use the durable path." });

    const events = await app.events.queryEvents();
    const responseIndex = events.findIndex((event) => event.type === "agent.userInput.responded");
    const completionIndex = events.findIndex((event) => event.type === "agent.turn.completed");
    expect(responseIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(responseIndex);
    expect(app.snapshot().projects[project.id]?.sessions[sessionId]?.state).toBe("idle");
    expect(app.snapshot().projects[project.id]?.turns[turnId]?.status).toBe("completed");
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("projects command run failures from provider events", async () => {
    const app = await createPraxisApp({ fakeScenario: "failure_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Run failing command" });

    expect(app.snapshot().projects[project.id]?.commandRuns).toEqual([
      expect.objectContaining({
        command: ["npm", "test"],
        status: "failed",
        exitCode: 1,
        stderrRef: "fake-check-output"
      })
    ]);
    expect(app.snapshot().dashboard.timeline.some((item) => item.kind === "command" && item.status === "failed")).toBe(true);
    await expect(app.replay()).resolves.toEqual(app.snapshot());
  });

  it("stores unknown provider events without mutating project state from the raw event", async () => {
    const app = await createPraxisApp({ fakeScenario: "unknown_event_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const before = app.snapshot().projects[project.id]?.runtimeState;
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Emit unknown" });

    const rawEvents = (await app.events.queryEvents()).filter((event) => event.type === "provider.rawEvent");
    expect(rawEvents).toHaveLength(1);
    expect(app.snapshot().dashboard.timeline.some((item) => item.title === "provider.rawEvent")).toBe(false);
    expect(before).toBe("idle");
  });

  it("interrupts only when provider capability supports it", async () => {
    const app = await createPraxisApp({ fakeScenario: "stale_path" });
    const rootPath = await createTempProject();
    const project = await app.projects.registerProject({ rootPath });
    const sessionId = await app.providers.startSession({ providerId: providerId("fake"), projectId: project.id, cwd: rootPath });
    const turnId = await app.providers.sendTurn({ providerId: providerId("fake"), projectId: project.id, sessionId, instruction: "Run" });

    await expect(
      app.providers.interruptTurn({ providerId: providerId("fake"), sessionId, turnId, reason: "User requested stop" })
    ).resolves.toBeUndefined();
  });

  it("updates dirty git state and links failed check output to changed files", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ git: true, failingTest: true });
    await writeFile(path.join(rootPath, "new-file.ts"), "export const value = 1;\n");
    const project = await app.projects.registerProject({ rootPath });
    const definition = app.checks.listDefinitions(project.id).find((check) => check.name === "test");
    expect(definition).toBeDefined();

    const run = await app.checks.runCheck(definition!);

    expect(run.status).toBe("failed");
    expect(run.relatedFiles).toContain("new-file.ts");
    expect(app.snapshot().projects[project.id]?.runtimeState).toBe("checks_failed");
    expect(app.snapshot().dashboard.mode).toBe("failure_triage");
    const projectedRun = app.snapshot().dashboard.checkRuns.find((item) => item.runId === run.id);
    expect(projectedRun).toMatchObject({
      name: "test",
      command: ["npm", "run", "test"],
      status: "failed",
      required: true,
      exitCode: 1,
      relatedFiles: expect.arrayContaining(["new-file.ts"])
    });
    expect(projectedRun?.durationMs).toBeGreaterThanOrEqual(0);
    expect(projectedRun?.output).toBeDefined();
  });
});

function sessionApprovalLimitedProvider(): ProviderAdapter {
  const id = providerId("session-approval-limited");
  const capabilities: ProviderCapabilities = {
    ...fakeProviderCapabilities,
    supportsPermissionProfiles: false
  };
  const events: DomainEvent[] = [];

  return {
    id,
    kind: "contract-test",
    displayName: "Session approval limited provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return capabilities;
    },
    async checkAvailability() {
      return { status: "available", version: "0.1.0" };
    },
    async startSession(input) {
      const sessionId = input.sessionId!;
      const event = createDomainEvent({
        type: "agent.session.started",
        projectId: input.projectId,
        sessionId,
        providerId: id,
        source: "provider",
        payload: { cwd: input.cwd, goal: input.goal },
        evidence: [{ type: "provider", providerId: id }]
      });
      events.push(event);
      return { sessionId, events: [event] };
    },
    async stopSession() {
      return undefined;
    },
    async sendTurn(input) {
      const turnId = input.turnId ?? agentTurnId();
      const approvalId = approvalRequestId();
      const now = new Date().toISOString();
      const approval: ApprovalRequest = {
        id: approvalId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: id,
        kind: "command",
        risk: "medium",
        riskSignals: ["runs_package_script"],
        title: "Run project command",
        description: "The agent requests permission to run a project command.",
        requestedAction: { command: ["npm", "test"] },
        status: "pending",
        createdAt: now,
        evidence: [{ type: "approval", approvalId }]
      };
      const turnStarted = createDomainEvent({
        type: "agent.turn.started",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: id,
        source: "provider",
        payload: { input: input.input },
        evidence: [{ type: "provider", providerId: id }]
      });
      const approvalRequested = createDomainEvent({
        type: "approval.requested",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: id,
        source: "provider",
        payload: approval,
        evidence: approval.evidence
      });
      events.push(turnStarted, approvalRequested);
      return { turnId, events: [turnStarted, approvalRequested] };
    },
    async respondToApproval() {
      return undefined;
    },
    async *watchEvents() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

function noStartProvider(): ProviderAdapter {
  const id = providerId("no-start-provider");
  const capabilities: ProviderCapabilities = {
    ...fakeProviderCapabilities,
    canStartSession: false
  };

  return {
    id,
    kind: "contract-test",
    displayName: "No-start provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return capabilities;
    },
    async checkAvailability() {
      return { status: "available", version: "0.1.0" };
    },
    async startSession() {
      throw new Error("Start sessions are not supported.");
    },
    async stopSession() {
      return undefined;
    },
    async sendTurn() {
      throw new Error("Turns are not supported without sessions.");
    },
    async respondToApproval() {
      return undefined;
    },
    async *watchEvents() {
      return undefined;
    }
  };
}

function sessionImportProvider(): ProviderAdapter {
  const id = providerId("session-import-provider");
  const capabilities: ProviderCapabilities = {
    ...fakeProviderCapabilities,
    canImportExistingSessions: true
  };

  return {
    id,
    kind: "contract-test",
    displayName: "Session import provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return capabilities;
    },
    async checkAvailability() {
      return { status: "available", version: "0.1.0" };
    },
    async startSession(input) {
      const sessionId = input.sessionId!;
      return {
        sessionId,
        events: [
          createDomainEvent({
            type: "agent.session.started",
            projectId: input.projectId,
            sessionId,
            providerId: id,
            source: "provider",
            payload: { cwd: input.cwd },
            evidence: [{ type: "provider", providerId: id }]
          })
        ]
      };
    },
    async stopSession() {
      return undefined;
    },
    async sendTurn(input) {
      const turnId = input.turnId ?? agentTurnId();
      return {
        turnId,
        events: [
          createDomainEvent({
            type: "agent.turn.completed",
            projectId: input.projectId,
            sessionId: input.sessionId,
            turnId,
            providerId: id,
            source: "provider",
            payload: { result: "Imported-provider turn complete." },
            evidence: [{ type: "provider", providerId: id }]
          })
        ]
      };
    },
    async respondToApproval() {
      return undefined;
    },
    async *importSessions(input) {
      const now = new Date().toISOString();
      yield {
        providerSessionRef: { providerId: id, externalId: "provider-session-1" },
        snapshot: input.projectId
          ? {
              session: {
                id: "provider-session-1" as AgentSessionId,
                projectId: input.projectId,
                providerId: id,
                cwd: "/provider-owned/session",
                state: "idle",
                createdAt: now,
                updatedAt: now
              },
              events: []
            }
          : undefined
      };
    },
    async *watchEvents() {
      return undefined;
    }
  };
}

function throwingTurnProvider(): ProviderAdapter {
  const id = providerId("throwing-turn-provider");
  const events: DomainEvent[] = [];

  return {
    id,
    kind: "contract-test",
    displayName: "Throwing turn provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return fakeProviderCapabilities;
    },
    async checkAvailability() {
      return { status: "available", version: "0.1.0" };
    },
    async startSession(input) {
      const sessionId = input.sessionId!;
      const event = createDomainEvent({
        type: "agent.session.started",
        projectId: input.projectId,
        sessionId,
        providerId: id,
        source: "provider",
        payload: { cwd: input.cwd, goal: input.goal },
        evidence: [{ type: "provider", providerId: id }]
      });
      events.push(event);
      return { sessionId, events: [event] };
    },
    async stopSession() {
      return undefined;
    },
    async sendTurn() {
      throw new Error("Provider process crashed before returning events.");
    },
    async respondToApproval() {
      return undefined;
    },
    async *watchEvents() {
      for (const event of events) {
        yield event;
      }
    }
  };
}
