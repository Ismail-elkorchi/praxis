import {
  agentSessionId,
  agentTurnId,
  approvalRequestId,
  commandRunId,
  eventId,
  fileChangeId,
  providerId
} from "../../core/ids";
import type {
  AgentSessionId,
  AgentTurnId,
  ApprovalDecision,
  ApprovalRequest,
  DomainEvent,
  FileChange,
  ProjectId,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderId,
  ProviderSessionRef
} from "../../core";
import { createDomainEvent } from "../../events/eventFactory";
import type {
  ApprovalDecisionInput,
  ProviderAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput,
  StartSessionResult,
  StopSessionInput,
  UserInputDecisionInput,
  WatchProviderEventsInput
} from "../interface";
import { fakeProviderScenarios, type FakeProviderScenarioName } from "./FakeProviderScenarios";

const now = () => new Date().toISOString();

export const fakeProviderCapabilities: ProviderCapabilities = {
  canStartSession: true,
  canResumeSession: true,
  canListSessions: true,
  canImportExistingSessions: false,
  canStreamEvents: true,
  canStreamTokenDeltas: true,
  canInterruptTurn: true,
  canSteerTurn: true,
  canRequestCommandApproval: true,
  canRequestFileApproval: true,
  canRunShellCommands: true,
  canEditFiles: true,
  canReportFileDiffs: true,
  canReportTokenUsage: false,
  canUseExternalTools: false,
  supportsSandboxing: true,
  supportsPermissionProfiles: true,
  supportsStructuredProtocol: true
};

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId = providerId("fake");
  readonly kind = "fake";
  readonly displayName = "Fake provider";
  readonly adapterVersion = "0.1.0";

  private readonly events: DomainEvent[] = [];
  private scenario: FakeProviderScenarioName;
  private capabilities: ProviderCapabilities = { ...fakeProviderCapabilities };
  private activeSessionId?: AgentSessionId;
  private activeProjectId?: ProjectId;
  private activeTurnId?: AgentTurnId;
  private pendingApproval?: ApprovalRequest;
  private pendingUserInput?: { projectId: ProjectId; sessionId: AgentSessionId; turnId: AgentTurnId };
  respondToUserInput?: (input: UserInputDecisionInput) => Promise<void>;

  constructor(input: { scenario?: FakeProviderScenarioName } = {}) {
    this.scenario = input.scenario ?? "happy_path";
    this.configureOptionalMethods();
  }

  setScenario(scenario: FakeProviderScenarioName): void {
    this.scenario = scenario;
    this.configureOptionalMethods();
  }

  setCapabilities(capabilities: Partial<ProviderCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...capabilities };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { ...this.capabilities };
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    if (fakeProviderScenarios[this.scenario].unavailable) {
      return { status: "unavailable", reason: "Fake provider scenario is unavailable." };
    }
    return { status: "available", version: this.adapterVersion };
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const sessionId = input.sessionId ?? agentSessionId();
    const providerSessionRef: ProviderSessionRef = {
      providerId: this.id,
      externalId: `fake-session-${sessionId}`,
      externalKind: "scenario"
    };
    const events = [
      this.event("agent.session.started", input.projectId, sessionId, {
        cwd: input.cwd,
        goal: input.goal,
        providerSessionRef
      })
    ];
    this.activeSessionId = sessionId;
    this.activeProjectId = input.projectId;
    this.events.push(...events);
    return { sessionId, providerSessionRef, events };
  }

  async resumeSession(input: { sessionId: AgentSessionId }): Promise<{ events: DomainEvent[] }> {
    const projectId = this.activeProjectId;
    if (!projectId) {
      return { events: [] };
    }
    const event = createDomainEvent({
      type: "agent.session.resumed",
      projectId,
      sessionId: input.sessionId,
      providerId: this.id,
      source: "provider",
      payload: { resumed: true },
      evidence: []
    });
    this.events.push(event);
    return { events: [event] };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    this.events.push({
      id: eventId(),
      type: "agent.session.stopped",
      version: 1,
      sessionId: input.sessionId,
      providerId: this.id,
      timestamp: now(),
      source: "provider",
      payload: { reason: input.reason ?? "stopped" },
      evidence: []
    });
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const turnId = input.turnId ?? agentTurnId();
    this.activeProjectId = input.projectId;
    this.activeSessionId = input.sessionId;
    this.activeTurnId = turnId;
    const events = this.eventsForScenario(input.projectId, input.sessionId, turnId, input.input);
    this.events.push(...events);
    return { turnId, events };
  }

  async respondToApproval(input: ApprovalDecisionInput): Promise<void> {
    if (!this.pendingApproval || input.approvalId !== this.pendingApproval.id) {
      return;
    }

    const projectId = this.pendingApproval.projectId;
    const sessionId = this.pendingApproval.sessionId;
    const turnId = this.pendingApproval.turnId;
    const continuation = continuationEventsAfterApproval({
      decision: input.decision,
      projectId,
      sessionId,
      turnId,
      providerId: this.id,
      scenario: this.scenario
    });
    this.pendingApproval = undefined;
    this.events.push(...continuation);
  }

  async interruptTurn(input: { sessionId: AgentSessionId; turnId: AgentTurnId; reason?: string }): Promise<void> {
    const projectId = this.activeProjectId;
    if (!projectId) return;
    this.events.push(
      createDomainEvent({
        type: "agent.turn.interrupted",
        projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: this.id,
        source: "provider",
        payload: { reason: input.reason ?? "Interrupted by user." },
        evidence: []
      })
    );
  }

  async steerTurn(input: { sessionId: AgentSessionId; turnId: AgentTurnId; input: string }): Promise<void> {
    const projectId = this.activeProjectId;
    if (!projectId) return;
    this.events.push(
      createDomainEvent({
        type: "agent.turn.delta",
        projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: this.id,
        source: "provider",
        payload: { text: input.input },
        evidence: []
      })
    );
  }

  private configureOptionalMethods(): void {
    this.respondToUserInput =
      this.scenario === "user_input_path" ? (input: UserInputDecisionInput) => this.handleUserInput(input) : undefined;
  }

  private async handleUserInput(input: UserInputDecisionInput): Promise<void> {
    if (!this.pendingUserInput || input.sessionId !== this.pendingUserInput.sessionId) return;
    this.events.push(
      createDomainEvent({
        type: "agent.turn.delta",
        projectId: this.pendingUserInput.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? this.pendingUserInput.turnId,
        providerId: this.id,
        source: "provider",
        payload: { text: `Received user input: ${input.input}` },
        evidence: []
      }),
      createDomainEvent({
        type: "agent.turn.completed",
        projectId: this.pendingUserInput.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? this.pendingUserInput.turnId,
        providerId: this.id,
        source: "provider",
        payload: { result: "User input received." },
        evidence: []
      })
    );
    this.pendingUserInput = undefined;
  }

  async *watchEvents(_input: WatchProviderEventsInput): AsyncIterable<DomainEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  private event(type: string, projectId: ProjectId, sessionId: AgentSessionId, payload: unknown): DomainEvent {
    return {
      id: eventId(),
      type,
      version: 1,
      projectId,
      sessionId,
      providerId: this.id,
      timestamp: now(),
      source: "provider",
      payload,
      evidence: []
    };
  }

  private eventsForScenario(
    projectId: ProjectId,
    sessionId: AgentSessionId,
    turnId: AgentTurnId,
    input: string
  ): DomainEvent[] {
    const started = createDomainEvent({
      type: "agent.turn.started",
      projectId,
      sessionId,
      turnId,
      providerId: this.id,
      source: "provider",
      payload: { inputSummary: input },
      evidence: []
    });

    if (this.scenario === "approval_path") {
      const approval = this.approval(projectId, sessionId, turnId, "command", "high");
      this.pendingApproval = approval;
      return [
        started,
        createDomainEvent({
          type: "approval.requested",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: approval,
          evidence: approval.evidence
        })
      ];
    }

    if (this.scenario === "file_change_path") {
      const approval = this.approval(projectId, sessionId, turnId, "file_change", "medium");
      this.pendingApproval = approval;
      const change = this.fileChange(projectId, sessionId, turnId, "src/example.ts", "proposed");
      return [
        started,
        createDomainEvent({
          type: "agent.fileChange.proposed",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: change,
          evidence: change.evidence
        }),
        createDomainEvent({
          type: "approval.requested",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: approval,
          evidence: approval.evidence
        })
      ];
    }

    if (this.scenario === "failure_path") {
      const commandId = commandRunId();
      const checkId = "fake-required-check" as never;
      return [
        started,
        createDomainEvent({
          type: "agent.command.started",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: {
            id: commandId,
            projectId,
            sessionId,
            turnId,
            command: ["npm", "test"],
            cwd: ".",
            status: "running",
            startedAt: now()
          },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.command.failed",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: {
            id: commandId,
            projectId,
            sessionId,
            turnId,
            command: ["npm", "test"],
            cwd: ".",
            status: "failed",
            exitCode: 1,
            startedAt: now(),
            completedAt: now(),
            stderrRef: "fake-check-output"
          },
          evidence: []
        }),
        createDomainEvent({
          type: "check.failed",
          projectId,
          turnId,
          providerId: this.id,
          source: "check",
          payload: {
            id: "fake-check-run",
            checkId,
            projectId,
            status: "failed",
            startedAt: now(),
            completedAt: now(),
            exitCode: 1,
            stderrRef: "fake-check-output",
            outputSummary: "Expected fake assertion to pass.",
            relatedFiles: ["src/example.ts"]
          },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.turn.failed",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { reason: "Command failed." },
          evidence: []
        })
      ];
    }

    if (this.scenario === "user_input_path") {
      this.pendingUserInput = { projectId, sessionId, turnId };
      return [
        started,
        createDomainEvent({
          type: "agent.userInput.requested",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: {
            title: "Clarify task",
            prompt: "Which implementation detail should the agent use?"
          },
          evidence: []
        })
      ];
    }

    if (this.scenario === "stale_path") {
      return [
        started,
        createDomainEvent({
          type: "provider.error",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { message: "Fake provider disconnected." },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.session.stale",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "system",
          payload: { reason: "Provider disconnected during an active turn." },
          evidence: []
        })
      ];
    }

    if (this.scenario === "unknown_event_path") {
      return [
        started,
        createDomainEvent({
          type: "provider.rawEvent",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { rawType: "unrecognized.fake.event", data: { preservedForAudit: true } },
          evidence: []
        }),
        createDomainEvent({
          type: "agent.turn.completed",
          projectId,
          sessionId,
          turnId,
          providerId: this.id,
          source: "provider",
          payload: { result: "Completed after unknown event was stored." },
          evidence: []
        })
      ];
    }

    return [
      started,
      createDomainEvent({
        type: "agent.turn.delta",
        projectId,
        sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { text: "Fake provider is working." },
        evidence: []
      }),
      createDomainEvent({
        type: "agent.turn.completed",
        projectId,
        sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { result: "Fake provider completed the turn." },
        evidence: []
      })
    ];
  }

  private approval(
    projectId: ProjectId,
    sessionId: AgentSessionId,
    turnId: AgentTurnId,
    kind: ApprovalRequest["kind"],
    risk: ApprovalRequest["risk"]
  ): ApprovalRequest {
    const id = approvalRequestId();
    return {
      id,
      projectId,
      sessionId,
      turnId,
      providerId: this.id,
      kind,
      risk,
      riskSignals: risk === "unknown" ? ["uses_full_access"] : ["runs_package_script"],
      title: kind === "command" ? "Run project command" : "Apply file change",
      description:
        kind === "command"
          ? "The agent requests permission to run a project command."
          : "The agent requests permission to apply a file change.",
      requestedAction: kind === "command" ? { command: ["npm", "test"] } : { path: "src/example.ts" },
      status: "pending",
      createdAt: now(),
      evidence: [{ type: "approval", approvalId: id }]
    };
  }

  private fileChange(
    projectId: ProjectId,
    sessionId: AgentSessionId,
    turnId: AgentTurnId | undefined,
    path: string,
    status: FileChange["status"]
  ): FileChange {
    const id = fileChangeId();
    return {
      id,
      projectId,
      sessionId,
      turnId,
      path,
      changeKind: "modified",
      status,
      diffRef: `fake-diff:${path}`,
      evidence: [{ type: "event", eventId: eventId() }]
    };
  }
}

function continuationEventsAfterApproval(input: {
  decision: ApprovalDecision;
  projectId: ProjectId;
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
  providerId: ProviderId;
  scenario: FakeProviderScenarioName;
}): DomainEvent[] {
  if (input.decision === "decline" || input.decision === "cancel") {
    return [
      createDomainEvent({
        type: "agent.turn.failed",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: input.providerId,
        source: "provider",
        payload: { reason: "Approval was not accepted." },
        evidence: []
      })
    ];
  }

  if (input.scenario === "file_change_path") {
    const changeId = fileChangeId();
    const change: FileChange = {
      id: changeId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      path: "src/example.ts",
      changeKind: "modified",
      status: "applied",
      diffRef: "fake-diff:src/example.ts",
      evidence: []
    };
    return [
      createDomainEvent({
        type: "agent.fileChange.applied",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: input.providerId,
        source: "provider",
        payload: change,
        evidence: []
      }),
      createDomainEvent({
        type: "agent.turn.completed",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: input.providerId,
        source: "provider",
        payload: { result: "File change applied." },
        evidence: []
      })
    ];
  }

  const commandId = commandRunId();
  return [
    createDomainEvent({
      type: "agent.command.started",
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: input.providerId,
      source: "provider",
      payload: {
        id: commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        command: ["npm", "test"],
        cwd: ".",
        status: "running",
        startedAt: now()
      },
      evidence: []
    }),
    createDomainEvent({
      type: "agent.command.completed",
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: input.providerId,
      source: "provider",
      payload: {
        id: commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        command: ["npm", "test"],
        cwd: ".",
        status: "completed",
        exitCode: 0,
        completedAt: now()
      },
      evidence: []
    }),
    createDomainEvent({
      type: "agent.turn.completed",
      projectId: input.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: input.providerId,
      source: "provider",
      payload: { result: "Approved command completed." },
      evidence: []
    })
  ];
}
