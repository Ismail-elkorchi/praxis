import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PraxisApi } from "../src/app/PraxisApi";
import {
  agentSessionId,
  agentTurnId,
  approvalRequestId,
  providerId,
  type AgentSessionId,
  type AgentTurnId,
  type ApprovalDecision,
  type ApprovalRequest,
  type DomainEvent,
  type ProjectId,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderSessionRef
} from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { createDomainEvent } from "../src/events/eventFactory";
import { SqliteEventStore } from "../src/events/SqliteEventStore";
import type {
  ApprovalDecisionInput,
  ProviderAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput,
  StartSessionResult,
  StopSessionInput,
  WatchProviderEventsInput
} from "../src/providers/interface";
import { createTempProject } from "./helpers/tempProject";

describe("project workspace model", () => {
  it("uses extensible ProjectProfile facets without a ProjectKind enum", async () => {
    const app = await createPraxisApp();
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({
      rootPath,
      name: "Market launch",
      profile: {
        userLabel: "Launch workspace",
        workModes: ["write", "research", "communicate", "custom"],
        sourceTypes: ["url", "note", "pasted_text", "custom"],
        expectedArtifactTypes: ["text_document", "research_summary", "plan", "custom"],
        customTags: ["go-to-market", "stakeholders"]
      }
    });

    expect(project.profile).toMatchObject({
      userLabel: "Launch workspace",
      workModes: expect.arrayContaining(["write", "research", "communicate", "custom"]),
      sourceTypes: expect.arrayContaining(["url", "note", "pasted_text", "custom"]),
      expectedArtifactTypes: expect.arrayContaining(["text_document", "research_summary", "plan", "custom"])
    });
    expect(app.snapshot().dashboard.projectCards[0]?.profileFacets).toEqual(
      expect.arrayContaining(["Launch workspace", "write", "research", "communicate"])
    );
    expect(await sourceTreeContains("ProjectKind")).toBe(false);
  });

  it("supports source, work item, artifact, Home, Workspace, replay, and SQLite read models", async () => {
    const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), "praxis-workspace-")), "praxis.sqlite");
    const store = new SqliteEventStore(databasePath);
    const app = await createPraxisApp({ eventStore: store });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({
      rootPath,
      name: "Research brief",
      profile: {
        userLabel: "Research workspace",
        workModes: ["research", "analyze", "write"],
        sourceTypes: ["url", "note"],
        expectedArtifactTypes: ["research_summary", "report", "structured_note"],
        customTags: ["customer"]
      }
    });

    const source = await app.workspace.addSource({
      projectId: project.id,
      type: "url",
      title: "Source article",
      uriOrPath: "https://example.test/research",
      metadata: { credibility: "reviewed" }
    });
    const workItem = await app.workItems.create({
      projectId: project.id,
      title: "Summarize evidence",
      goal: "Create a concise research summary with cited source notes.",
      workModes: ["research", "write"],
      sourceIds: [source.id],
      priority: 1
    });
    await app.workItems.queue({ projectId: project.id, workItemId: workItem.id });
    const artifact = await app.artifacts.create({
      projectId: project.id,
      workItemId: workItem.id,
      type: "research_summary",
      title: "Evidence summary",
      summary: "Source-linked synthesis.",
      sourceIds: [source.id],
      evidence: [{ type: "user", commandId: "fixture:evidence" }]
    });
    await app.artifacts.markReviewed({ projectId: project.id, artifactId: artifact.id });
    await app.artifacts.accept({ projectId: project.id, artifactId: artifact.id });
    await app.workspace.removeSource({ projectId: project.id, sourceId: source.id });

    const snapshot = app.snapshot();
    const projectSnapshot = snapshot.projects[project.id]!;
    expect(projectSnapshot.profile.workModes).toEqual(expect.arrayContaining(["research", "analyze", "write"]));
    expect(projectSnapshot.sources.some((item) => item.id === source.id)).toBe(false);
    expect(projectSnapshot.workItems[0]).toMatchObject({ title: "Summarize evidence", status: "queued" });
    expect(projectSnapshot.artifacts[0]).toMatchObject({ title: "Evidence summary", status: "accepted", type: "research_summary" });
    expect(snapshot.dashboard.home.workInbox.some((item) => item.title === "Summarize evidence")).toBe(true);
    expect(app.workspace.getWorkspace(project.id)).toMatchObject({
      header: expect.objectContaining({ name: "Research brief" }),
      workItems: expect.objectContaining({ queued: [expect.objectContaining({ id: workItem.id })] }),
      artifacts: [expect.objectContaining({ id: artifact.id })]
    });
    await expect(app.replay()).resolves.toEqual(app.snapshot());

    expect(store.countRows("project_profiles")).toBe(1);
    expect(store.countRows("project_sources")).toBeGreaterThanOrEqual(2);
    expect(store.countRows("project_work_items")).toBe(1);
    expect(store.countRows("project_artifacts")).toBe(1);
    expect(store.countRows("artifact_evidence_refs")).toBe(1);
    expect(store.countRows("work_item_source_refs")).toBe(0);
    expect(store.countRows("work_item_artifact_refs")).toBe(1);
    store.close();
  });

  it("supports broad non-code project artifacts with the fake provider available", async () => {
    const app = await createPraxisApp();
    const fixtures = [
      { name: "Code project", workModes: ["build", "test"], artifacts: ["code_patch", "test_or_check_result"] },
      { name: "Writing project", workModes: ["write"], artifacts: ["text_document", "checklist"] },
      { name: "Research project", workModes: ["research", "analyze"], artifacts: ["research_summary", "report", "structured_note"] },
      { name: "Planning project", workModes: ["plan"], artifacts: ["plan", "decision_record"] },
      { name: "General project", workModes: ["custom"], artifacts: ["custom"] }
    ] as const;

    for (const fixture of fixtures) {
      const rootPath = await createTempProject({ packageJson: false });
      const project = await app.projects.registerProject({
        rootPath,
        name: fixture.name,
        profile: {
          userLabel: fixture.name,
          workModes: [...fixture.workModes],
          sourceTypes: ["note", "local_folder"],
          expectedArtifactTypes: [...fixture.artifacts],
          customTags: []
        }
      });
      const workItem = await app.workItems.create({
        projectId: project.id,
        title: `${fixture.name} work`,
        goal: "Produce project output.",
        workModes: [...fixture.workModes]
      });
      for (const artifactType of fixture.artifacts) {
        await app.artifacts.create({
          projectId: project.id,
          workItemId: workItem.id,
          type: artifactType,
          title: `${fixture.name} ${artifactType}`,
          summary: "Fixture artifact"
        });
      }
      expect(app.snapshot().projects[project.id]?.artifacts.map((artifact) => artifact.type)).toEqual(
        expect.arrayContaining([...fixture.artifacts])
      );
    }

    expect(app.providerRegistry.listRealProviders()).toEqual([]);
    expect(app.snapshot().dashboard.providerStatus.map((provider) => provider.name)).toEqual(["Fake provider"]);
  });

  it("exposes workspace, work item, agent run, and artifact APIs", async () => {
    const app = await createPraxisApp();
    const api = new PraxisApi(app);
    const rootPath = await createTempProject({ packageJson: false });
    const registered = await api.handle({
      id: "register",
      method: "projects.register",
      params: {
        rootPath,
        name: "API workspace",
        profile: {
          userLabel: "API project",
          workModes: ["operate", "automate"],
          sourceTypes: ["note"],
          expectedArtifactTypes: ["checklist"],
          customTags: []
        }
      }
    });
    const project = ("result" in registered ? registered.result : undefined) as { id: ProjectId };

    await expect(
      api.handle({ id: "profile", method: "projects.updateProfile", params: { projectId: project.id, profile: { customTags: ["api"] } } })
    ).resolves.toMatchObject({ id: "profile", result: expect.objectContaining({ customTags: ["api"] }) });
    const sourceResponse = await api.handle({
      id: "source",
      method: "projects.addSource",
      params: { projectId: project.id, type: "note", title: "Operator note" }
    });
    const source = ("result" in sourceResponse ? sourceResponse.result : undefined) as { id: string };
    const workItemResponse = await api.handle({
      id: "work",
      method: "workItems.create",
      params: { projectId: project.id, title: "Run checklist", goal: "Prepare the checklist.", sourceIds: [source.id] }
    });
    const workItem = ("result" in workItemResponse ? workItemResponse.result : undefined) as { id: string };
    await expect(api.handle({ id: "queue", method: "workItems.queue", params: { projectId: project.id, workItemId: workItem.id } })).resolves.toMatchObject({
      result: expect.objectContaining({ status: "queued" })
    });
    const artifactResponse = await api.handle({
      id: "artifact",
      method: "artifacts.create",
      params: { projectId: project.id, workItemId: workItem.id, type: "checklist", title: "Operations checklist" }
    });
    const artifact = ("result" in artifactResponse ? artifactResponse.result : undefined) as { id: string };
    await expect(api.handle({ id: "accept", method: "artifacts.accept", params: { projectId: project.id, artifactId: artifact.id } })).resolves.toMatchObject({
      result: expect.objectContaining({ status: "accepted" })
    });
    const runResponse = await api.handle({
      id: "run",
      method: "agentRuns.create",
      params: {
        projectId: project.id,
        workItemId: workItem.id,
        providerId: providerId("fake"),
        roleName: "Operator",
        rolePreset: "operator",
        goal: "Operate safely.",
        cwd: rootPath
      }
    });
    const run = ("result" in runResponse ? runResponse.result : undefined) as { id: string };
    await expect(api.handle({ id: "runs", method: "agentRuns.listByWorkItem", params: { projectId: project.id, workItemId: workItem.id } })).resolves.toMatchObject({
      result: [expect.objectContaining({ id: run.id, roleName: "Operator" })]
    });
    await expect(api.handle({ id: "workspace", method: "projects.getWorkspace", params: { projectId: project.id } })).resolves.toMatchObject({
      result: expect.objectContaining({ header: expect.objectContaining({ name: "API workspace" }) })
    });
    await expect(api.handle({ id: "home", method: "projects.getHome" })).resolves.toMatchObject({
      result: expect.objectContaining({ quickCreate: expect.any(Array) })
    });
    await expect(api.handle({ id: "portfolio", method: "projects.getPortfolio" })).resolves.toMatchObject({
      result: [expect.objectContaining({ title: "API workspace" })]
    });
  });

  it("aggregates three or more agent runs across same-provider and multi-provider projects", async () => {
    const secondary = new ApprovalFixtureProvider(providerId("workspace-secondary"), "Workspace secondary provider");
    const app = await createPraxisApp({ providerAdapters: [secondary] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath, defaultProviderId: providerId("fake") });
    const workItem = await app.workItems.create({
      projectId: project.id,
      title: "Prepare workspace",
      goal: "Run multiple visible worker attempts.",
      workModes: ["plan", "write", "review"]
    });

    const planner = await app.agentRuns.create({
      projectId: project.id,
      workItemId: workItem.id,
      providerId: providerId("fake"),
      roleName: "Planning lead",
      rolePreset: "planner",
      goal: "Create the plan.",
      cwd: rootPath
    });
    const writer = await app.agentRuns.create({
      projectId: project.id,
      workItemId: workItem.id,
      providerId: providerId("fake"),
      roleName: "Draft writer",
      rolePreset: "writer",
      goal: "Draft the artifact.",
      cwd: rootPath
    });
    const reviewer = await app.agentRuns.create({
      projectId: project.id,
      workItemId: workItem.id,
      providerId: secondary.id,
      roleName: "Review partner",
      rolePreset: "reviewer",
      goal: "Review the draft.",
      cwd: rootPath
    });

    expect(app.snapshot().projects[project.id]?.agentRuns).toHaveLength(3);
    expect(app.snapshot().dashboard.projectCards[0]).toMatchObject({
      currentWorkItemTitle: "Prepare workspace",
      activeAgentCount: 0
    });

    await app.agentRuns.start({ projectId: project.id, agentRunId: planner.id, instruction: "Plan now." });
    await app.agentRuns.linkSession({ projectId: project.id, agentRunId: writer.id, sessionId: app.snapshot().projects[project.id]!.agentRuns[0]!.sessionId! });
    const reviewerSession = await app.providers.startSession({ providerId: secondary.id, projectId: project.id, cwd: rootPath, goal: "Review" });
    await app.agentRuns.linkSession({ projectId: project.id, agentRunId: reviewer.id, sessionId: reviewerSession });

    const projectState = app.snapshot().projects[project.id]!;
    expect(projectState.agentRuns.map((run) => run.providerId)).toEqual(expect.arrayContaining([providerId("fake"), secondary.id]));
    expect(projectState.agentRuns.filter((run) => run.providerId === providerId("fake"))).toHaveLength(2);
    expect(app.workspace.getWorkspace(project.id).agentBoard.done.length + app.workspace.getWorkspace(project.id).agentBoard.running.length).toBeGreaterThanOrEqual(2);
  });

  it("routes approval decisions through the provider id on each approval card", async () => {
    const providerA = new ApprovalFixtureProvider(providerId("approval-a"), "Approval provider A");
    const providerB = new ApprovalFixtureProvider(providerId("approval-b"), "Approval provider B");
    const app = await createPraxisApp({ providerAdapters: [providerA, providerB] });
    const rootPath = await createTempProject({ packageJson: false });
    const project = await app.projects.registerProject({ rootPath });
    const sessionA = await app.providers.startSession({ providerId: providerA.id, projectId: project.id, cwd: rootPath });
    const sessionB = await app.providers.startSession({ providerId: providerB.id, projectId: project.id, cwd: rootPath });

    await app.providers.sendTurn({ providerId: providerA.id, projectId: project.id, sessionId: sessionA, instruction: "Approval A" });
    await app.providers.sendTurn({ providerId: providerB.id, projectId: project.id, sessionId: sessionB, instruction: "Approval B" });

    const cards = app.snapshot().dashboard.approvals;
    expect(cards.map((approval) => approval.providerId)).toEqual(expect.arrayContaining([providerA.id, providerB.id]));
    for (const card of cards) {
      await app.providers.decideApproval({ providerId: card.providerId, approvalId: card.approvalId, decision: "accept_once" });
    }

    expect(providerA.decisions).toEqual(["accept_once"]);
    expect(providerB.decisions).toEqual(["accept_once"]);
  });
});

async function sourceTreeContains(term: string): Promise<boolean> {
  const files = await listSourceFiles(path.join(process.cwd(), "src"));
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return contents.some((content) => content.includes(term));
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    })
  );
  return nested.flat();
}

class ApprovalFixtureProvider implements ProviderAdapter {
  readonly adapterVersion = "0.1.0";
  readonly kind = "fixture";
  readonly decisions: ApprovalDecision[] = [];
  private readonly events: DomainEvent[] = [];
  private readonly sessions = new Map<AgentSessionId, { projectId: ProjectId; providerSessionRef: ProviderSessionRef }>();

  constructor(readonly id: ProviderId, readonly displayName: string) {}

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      canStartSession: true,
      canResumeSession: false,
      canListSessions: false,
      canImportExistingSessions: false,
      canStreamEvents: true,
      canStreamTokenDeltas: false,
      canInterruptTurn: false,
      canSteerTurn: false,
      canRequestCommandApproval: true,
      canRequestFileApproval: false,
      canRunShellCommands: true,
      canEditFiles: false,
      canReportFileDiffs: false,
      canReportTokenUsage: false,
      canUseExternalTools: false,
      supportsSandboxing: true,
      supportsPermissionProfiles: true,
      supportsStructuredProtocol: true
    };
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return { status: "available", version: this.adapterVersion };
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const sessionId = input.sessionId ?? agentSessionId();
    const providerSessionRef: ProviderSessionRef = {
      providerId: this.id,
      externalId: `${this.id}:${sessionId}`,
      externalKind: "fixture"
    };
    this.sessions.set(sessionId, { projectId: input.projectId, providerSessionRef });
    const event = createDomainEvent({
      type: "agent.session.started",
      projectId: input.projectId,
      sessionId,
      providerId: this.id,
      source: "provider",
      payload: { cwd: input.cwd, goal: input.goal, providerSessionRef },
      evidence: [{ type: "provider", providerId: this.id, externalId: providerSessionRef.externalId }]
    });
    this.events.push(event);
    return { sessionId, providerSessionRef, events: [event] };
  }

  async stopSession(_input: StopSessionInput): Promise<void> {}

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const session = this.sessions.get(input.sessionId);
    const turnId = input.turnId ?? agentTurnId();
    const approvalId = approvalRequestId();
    const approval: ApprovalRequest = {
      id: approvalId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId,
      providerId: this.id,
      kind: "command",
      risk: "high",
      riskSignals: ["runs_package_script"],
      title: `${this.displayName} approval`,
      description: "Fixture approval",
      requestedAction: { command: ["fixture"] },
      status: "pending",
      createdAt: new Date().toISOString(),
      evidence: [{ type: "approval", approvalId }]
    };
    const events = [
      createDomainEvent({
        type: "agent.turn.started",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { inputSummary: input.input, providerSessionRef: session?.providerSessionRef },
        evidence: []
      }),
      createDomainEvent({
        type: "approval.requested",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: approval,
        evidence: approval.evidence
      })
    ];
    this.events.push(...events);
    return { turnId, events };
  }

  async respondToApproval(input: ApprovalDecisionInput): Promise<void> {
    this.decisions.push(input.decision);
    const session = this.sessions.get(input.sessionId);
    const event = createDomainEvent({
      type: "agent.turn.completed",
      projectId: session?.projectId,
      sessionId: input.sessionId,
      providerId: this.id,
      source: "provider",
      payload: { result: "approved" },
      evidence: []
    });
    this.events.push(event);
  }

  async *watchEvents(_input: WatchProviderEventsInput): AsyncIterable<DomainEvent> {
    for (const event of this.events) yield event;
  }
}
