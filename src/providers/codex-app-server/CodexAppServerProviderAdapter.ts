import {
  agentTurnId,
  agentSessionId,
  type AgentSession,
  type AgentSessionId,
  type AgentTurnId,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalRequestId,
  type DomainEvent,
  type ProjectId,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderId,
  providerId,
  type ProviderSessionRef
} from "../../core";
import { createDomainEvent } from "../../events/eventFactory";
import type {
  AgentSessionListPage,
  AgentSessionSnapshot,
  ApprovalDecisionInput,
  ImportedProviderSession,
  ImportSessionsInput,
  InterruptTurnInput,
  ProviderAdapter,
  ReadSessionInput,
  ResumeSessionInput,
  ResumeSessionResult,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput,
  StartSessionResult,
  SteerTurnInput,
  StopSessionInput,
  UserInputDecisionInput,
  WatchProviderEventsInput
} from "../interface";
import {
  checkCodexAppServerAvailability,
  defaultCodexCommand,
  defaultMinimumVersion,
  schemaStrategy
} from "./Compatibility";
import { codexFeatureMatrix } from "./FeatureMatrix";
import { CodexEventNormalizer } from "./EventNormalizer";
import { CodexJsonRpcClient } from "./JsonRpcClient";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "./ProtocolTypes";
import { codexErrorMessage, codexErrorName } from "./errors";
import { redactCodexValue } from "./redaction";

export type CodexAppServerProviderOptions = {
  id?: ProviderId;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  minimumVersion?: string;
  requestTimeoutMs?: number;
  maxOverloadRetries?: number;
  notificationOptOut?: boolean;
  experimentalApi?: boolean;
  clientInfo?: { name: string; version: string };
};

type SessionContext = {
  sessionId: AgentSessionId;
  projectId: ProjectId;
  threadId: string;
  cwd: string;
  goal?: string;
  providerSessionRef: ProviderSessionRef;
};

type PendingApproval = {
  requestId: JsonRpcId;
  approvalId: ApprovalRequestId;
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
  kind: ApprovalRequest["kind"];
};

type PendingUserInput = {
  requestId: JsonRpcId;
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
};

export class CodexAppServerProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly kind = "codex-app-server";
  readonly displayName = "Codex app-server";
  readonly adapterVersion = "0.1.0";

  private readonly command: string;
  private readonly args: string[];
  private readonly normalizer = new CodexEventNormalizer();
  private readonly events: DomainEvent[] = [];
  private readonly sessions = new Map<AgentSessionId, SessionContext>();
  private readonly sessionsByThreadId = new Map<string, AgentSessionId>();
  private readonly localTurnsByExternalTurnId = new Map<string, AgentTurnId>();
  private readonly externalTurnsByLocalTurnId = new Map<AgentTurnId, string>();
  private readonly pendingLocalTurnsBySessionId = new Map<AgentSessionId, AgentTurnId>();
  private readonly pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
  private readonly pendingUserInputs = new Map<AgentSessionId, PendingUserInput>();
  private client?: CodexJsonRpcClient;
  private initialized = false;

  constructor(private readonly options: CodexAppServerProviderOptions = {}) {
    this.id = options.id ?? providerId("codex-app-server");
    this.command = options.command ?? defaultCodexCommand;
    this.args = options.args ?? ["app-server", "--stdio"];
    if (options.experimentalApi === true) {
      this.events.push(this.adapterError("Experimental Codex app-server APIs are disabled by default.", undefined, undefined, undefined));
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      canStartSession: true,
      canResumeSession: true,
      canListSessions: true,
      canImportExistingSessions: true,
      canStreamEvents: true,
      canStreamTokenDeltas: true,
      canInterruptTurn: true,
      canSteerTurn: true,
      canRequestCommandApproval: true,
      canRequestFileApproval: true,
      canRunShellCommands: true,
      canEditFiles: true,
      canReportFileDiffs: true,
      canReportTokenUsage: true,
      canUseExternalTools: false,
      supportsSandboxing: true,
      supportsPermissionProfiles: true,
      supportsStructuredProtocol: true
    };
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return checkCodexAppServerAvailability({
      command: this.command,
      minimumVersion: this.options.minimumVersion ?? defaultMinimumVersion,
      timeoutMs: this.options.requestTimeoutMs
    });
  }

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const startIndex = this.events.length;
    await this.ensureInitialized();
    const result = await this.request<{ threadId?: string; thread?: { id?: string }; id?: string }>("thread/start", {
      cwd: input.cwd,
      goal: input.goal,
      experimentalApi: false
    });
    const threadId = result.threadId ?? result.thread?.id ?? result.id;
    if (!threadId) {
      const error = this.adapterError("Codex app-server did not return a thread id.", input.projectId, input.sessionId, undefined);
      this.events.push(error);
      throw new Error("Codex app-server did not return a thread id.");
    }

    const sessionId = input.sessionId ?? agentSessionId();
    const providerSessionRef = this.providerSessionRef(threadId);
    this.registerSession({ sessionId, projectId: input.projectId, threadId, cwd: input.cwd, goal: input.goal, providerSessionRef });
    this.events.push(
      createDomainEvent({
        type: "agent.session.started",
        projectId: input.projectId,
        sessionId,
        providerId: this.id,
        source: "provider",
        payload: { cwd: input.cwd, goal: input.goal, providerSessionRef },
        evidence: [{ type: "provider", providerId: this.id, externalId: threadId }]
      })
    );
    return { sessionId, providerSessionRef, events: this.events.slice(startIndex) };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
    const startIndex = this.events.length;
    const session = this.requireSession(input.sessionId);
    await this.ensureInitialized();
    await this.request("thread/resume", { threadId: session.threadId });
    this.events.push(
      createDomainEvent({
        type: "agent.session.resumed",
        projectId: session.projectId,
        sessionId: input.sessionId,
        providerId: this.id,
        source: "provider",
        payload: { providerSessionRef: session.providerSessionRef },
        evidence: [{ type: "provider", providerId: this.id, externalId: session.threadId }]
      })
    );
    return { events: this.events.slice(startIndex) };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    await this.ensureInitialized();
    await this.request("thread/unsubscribe", { threadId: session.threadId, reason: input.reason ?? "detached" });
    this.events.push(
      createDomainEvent({
        type: "agent.session.stopped",
        projectId: session.projectId,
        sessionId: input.sessionId,
        providerId: this.id,
        source: "provider",
        payload: { reason: input.reason ?? "Detached from provider session." },
        evidence: [{ type: "provider", providerId: this.id, externalId: session.threadId }]
      })
    );
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const startIndex = this.events.length;
    const session = this.requireSession(input.sessionId);
    const turnId = input.turnId ?? agentTurnId();
    this.pendingLocalTurnsBySessionId.set(input.sessionId, turnId);
    this.events.push(
      createDomainEvent({
        type: "agent.turn.started",
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { inputSummary: input.input },
        evidence: [{ type: "provider", providerId: this.id, externalId: session.threadId }]
      })
    );

    try {
      await this.ensureInitialized();
      const result = await this.request<{ turnId?: string; id?: string }>("turn/start", {
        threadId: session.threadId,
        input: input.input,
        experimentalApi: false
      });
      const externalTurnId = result.turnId ?? result.id;
      if (externalTurnId) {
        this.mapExternalTurn(externalTurnId, turnId);
      }
      this.pendingLocalTurnsBySessionId.delete(input.sessionId);
      return { turnId, events: this.events.slice(startIndex) };
    } catch (error) {
      this.pendingLocalTurnsBySessionId.delete(input.sessionId);
      this.events.push(...this.providerTurnFailureEvents(error, input.projectId, input.sessionId, turnId));
      return { turnId, events: this.events.slice(startIndex) };
    }
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const externalTurnId = this.externalTurnsByLocalTurnId.get(input.turnId);
    if (!externalTurnId) {
      this.events.push(this.adapterError("Cannot steer a turn before the provider reports an active turn.", session.projectId, input.sessionId, input.turnId));
      throw new Error("Cannot steer a turn before the provider reports an active turn.");
    }
    await this.ensureInitialized();
    await this.request("turn/steer", { threadId: session.threadId, turnId: externalTurnId, input: input.input });
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const externalTurnId = this.externalTurnsByLocalTurnId.get(input.turnId);
    await this.ensureInitialized();
    await this.request("turn/interrupt", { threadId: session.threadId, turnId: externalTurnId, reason: input.reason });
    this.events.push(
      createDomainEvent({
        type: "agent.turn.interrupted",
        projectId: session.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: this.id,
        source: "provider",
        payload: { reason: input.reason ?? "Interrupted by user." },
        evidence: [{ type: "provider", providerId: this.id, externalId: session.threadId }]
      })
    );
  }

  async respondToApproval(input: ApprovalDecisionInput): Promise<void> {
    const pending = this.pendingApprovals.get(input.approvalId);
    if (!pending || pending.sessionId !== input.sessionId) {
      throw new Error("Codex app-server approval request is no longer pending.");
    }
    const decision = mapApprovalDecision(input.decision);
    if (!decision) {
      this.client?.respondError(pending.requestId, { code: -32001, message: "Unsupported approval decision." });
      throw new Error("Unsupported approval decision.");
    }
    await this.ensureInitialized();
    this.client!.respond(pending.requestId, { decision });
    await delay(25);
    this.pendingApprovals.delete(input.approvalId);
  }

  async respondToUserInput(input: UserInputDecisionInput): Promise<void> {
    const pending = this.pendingUserInputs.get(input.sessionId);
    if (!pending) {
      throw new Error("Codex app-server user input request is no longer pending.");
    }
    await this.ensureInitialized();
    this.client!.respond(pending.requestId, { input: input.input });
    await delay(25);
    this.pendingUserInputs.delete(input.sessionId);
  }

  async readSession(input: ReadSessionInput): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(input.sessionId);
    await this.ensureInitialized();
    await this.request("thread/read", { threadId: session.threadId });
    return {
      session: this.agentSession(session, "idle"),
      events: this.events.filter((event) => event.sessionId === input.sessionId)
    };
  }

  async listSessions(input: { projectId?: ProjectId; cursor?: string; limit?: number }): Promise<AgentSessionListPage> {
    await this.ensureInitialized();
    const result = await this.request<{ threads?: unknown[]; nextCursor?: string }>("thread/list", {
      cursor: input.cursor,
      limit: input.limit
    });
    const sessions = (result.threads ?? [])
      .map((thread) => this.sessionFromThread(thread, input.projectId))
      .filter((session): session is AgentSession => Boolean(session))
      .slice(0, input.limit ?? 100);
    return { sessions, nextCursor: result.nextCursor };
  }

  async *importSessions(input: ImportSessionsInput): AsyncIterable<ImportedProviderSession> {
    const list = await this.listSessions({ projectId: input.projectId });
    for (const session of list.sessions) {
      const context = this.sessions.get(session.id);
      if (!context) continue;
      yield {
        providerSessionRef: context.providerSessionRef,
        snapshot: { session, events: [] }
      };
    }
  }

  async *watchEvents(_input: WatchProviderEventsInput): AsyncIterable<DomainEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  capabilityMatrix() {
    return codexFeatureMatrix.map((entry) => ({ ...entry }));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.client) {
      this.client = new CodexJsonRpcClient({
        command: this.command,
        args: this.args,
        cwd: this.options.cwd,
        env: this.options.env,
        requestTimeoutMs: this.options.requestTimeoutMs,
        maxOverloadRetries: this.options.maxOverloadRetries,
        onNotification: (notification) => this.handleNotification(notification),
        onServerRequest: (request) => this.handleServerRequest(request),
        onStderr: (line) => this.events.push(this.rawProviderEvent("stderr", { line })),
        onCrash: (error) => this.handleCrash(error)
      });
      this.client.start();
      this.events.push(
        createDomainEvent({
          type: "provider.client.started",
          providerId: this.id,
          source: "provider",
          payload: { message: "Provider client started.", transport: "stdio" },
          evidence: []
        })
      );
    }
    if (this.initialized) return;
    await this.client.request("initialize", {
      clientInfo: this.options.clientInfo ?? { name: "Praxis", version: "0.1.0" },
      experimentalApi: false,
      notifications: { disabled: this.options.notificationOptOut === true },
      schemaStrategy: schemaStrategy(this.command)
    });
    if (!this.options.notificationOptOut) {
      this.client.notify("initialized", {});
    }
    this.initialized = true;
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureInitialized();
    return this.client!.request<T>(method, params);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.learnExternalTurn(notification.params);
    const events = this.normalizer.normalize(notification, this.normalizationContext());
    this.events.push(...events);
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    if (isApprovalRequestMethod(request.method)) {
      this.handleApprovalRequest(request);
      return;
    }
    if (request.method === "tool/requestUserInput") {
      this.handleUserInputRequest(request);
      return;
    }
    this.events.push(this.rawProviderEvent("unsupported_server_request", { method: request.method, params: request.params }));
    this.client?.respondError(request.id, { code: -32601, message: "Unsupported provider request." });
  }

  private handleApprovalRequest(request: JsonRpcRequest): void {
    const params = objectPayload(request.params);
    const scope = this.scopeFromParams(params);
    if (!scope.projectId || !scope.sessionId) {
      this.events.push(this.adapterError("Provider approval request did not include a known session scope.", scope.projectId, scope.sessionId, scope.turnId));
      this.client?.respondError(request.id, { code: -32002, message: "Approval request scope is unknown." });
      return;
    }
    const kind = approvalKind(request.method, params);
    if (!kind) {
      this.events.push(this.adapterError("Provider approval request type is unsupported.", scope.projectId, scope.sessionId, scope.turnId));
      this.client?.respondError(request.id, { code: -32003, message: "Approval request type is unsupported." });
      return;
    }
    const approval = this.approvalFromRequest(request, scope.projectId, scope.sessionId, scope.turnId, kind);
    this.pendingApprovals.set(approval.id, { requestId: request.id, approvalId: approval.id, sessionId: scope.sessionId, turnId: scope.turnId, kind });
    this.events.push(
      createDomainEvent({
        type: "approval.requested",
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        providerId: this.id,
        source: "provider",
        payload: approval,
        evidence: approval.evidence
      })
    );
  }

  private handleUserInputRequest(request: JsonRpcRequest): void {
    const params = objectPayload(request.params);
    const scope = this.scopeFromParams(params);
    if (!scope.projectId || !scope.sessionId) {
      this.events.push(this.adapterError("Provider user-input request did not include a known session scope.", scope.projectId, scope.sessionId, scope.turnId));
      this.client?.respondError(request.id, { code: -32004, message: "User input request scope is unknown." });
      return;
    }
    this.pendingUserInputs.set(scope.sessionId, { requestId: request.id, sessionId: scope.sessionId, turnId: scope.turnId });
    this.events.push(
      createDomainEvent({
        type: "agent.userInput.requested",
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        providerId: this.id,
        source: "provider",
        payload: {
          title: textField(params, "title") ?? "Provider needs input",
          prompt: textField(params, "prompt") ?? textField(params, "message") ?? "Provide input for the active session."
        },
        evidence: []
      })
    );
  }

  private handleCrash(error: Error): void {
    this.events.push(this.adapterError(error.message, undefined, undefined, undefined));
    for (const session of this.sessions.values()) {
      this.events.push(
        createDomainEvent({
          type: "agent.session.stale",
          projectId: session.projectId,
          sessionId: session.sessionId,
          providerId: this.id,
          source: "provider",
          payload: { reason: "Provider process crashed.", message: error.message },
          evidence: [{ type: "provider", providerId: this.id, externalId: session.threadId }]
        })
      );
    }
    this.client = undefined;
    this.initialized = false;
  }

  private providerTurnFailureEvents(
    error: unknown,
    projectId: ProjectId,
    sessionId: AgentSessionId,
    turnId: AgentTurnId
  ): DomainEvent[] {
    const message = codexErrorMessage(error);
    const category = codexErrorName(error);
    return [
      createDomainEvent({
        type: "provider.error",
        projectId,
        sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { message, category },
        evidence: [{ type: "provider", providerId: this.id }]
      }),
      createDomainEvent({
        type: "agent.turn.failed",
        projectId,
        sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { reason: message, category },
        evidence: [{ type: "provider", providerId: this.id }]
      }),
      createDomainEvent({
        type: "agent.session.stale",
        projectId,
        sessionId,
        turnId,
        providerId: this.id,
        source: "provider",
        payload: { reason: "Provider turn failed.", category },
        evidence: [{ type: "provider", providerId: this.id }]
      })
    ];
  }

  private approvalFromRequest(
    request: JsonRpcRequest,
    projectId: ProjectId,
    sessionId: AgentSessionId,
    turnId: AgentTurnId | undefined,
    kind: ApprovalRequest["kind"]
  ): ApprovalRequest {
    const params = objectPayload(request.params);
    const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}` as ApprovalRequestId;
    return {
      id,
      projectId,
      sessionId,
      turnId,
      providerId: this.id,
      kind,
      risk: kind === "network" ? "high" : kind === "file_change" ? "medium" : "high",
      riskSignals: riskSignals(kind, params),
      title: approvalTitle(kind, params),
      description: approvalDescription(kind, params),
      requestedAction: redactCodexValue(providerNeutralRequestedAction(kind, params)),
      status: "pending",
      createdAt: new Date().toISOString(),
      evidence: [{ type: "approval", approvalId: id }]
    };
  }

  private adapterError(message: string, projectId: ProjectId | undefined, sessionId: AgentSessionId | undefined, turnId: AgentTurnId | undefined): DomainEvent {
    return createDomainEvent({
      type: "provider.error",
      projectId,
      sessionId,
      turnId,
      providerId: this.id,
      source: "provider",
      payload: { message },
      evidence: [{ type: "provider", providerId: this.id }]
    });
  }

  private rawProviderEvent(reason: string, payload: unknown): DomainEvent {
    return createDomainEvent({
      type: "provider.rawEvent",
      providerId: this.id,
      source: "provider",
      payload: redactCodexValue({ reason, payload }),
      evidence: []
    });
  }

  private normalizationContext() {
    return {
      providerId: this.id,
      threadIdToSessionId: (threadId: string) => this.sessionsByThreadId.get(threadId),
      sessionIdToProjectId: (sessionId: AgentSessionId) => this.sessions.get(sessionId)?.projectId,
      localTurnId: (externalTurnId: string, sessionId?: AgentSessionId) =>
        this.localTurnsByExternalTurnId.get(externalTurnId) ?? (sessionId ? this.pendingLocalTurnsBySessionId.get(sessionId) : undefined),
      commandRunIdFor: (externalId: string) => this.normalizer.commandRunIdFor(externalId),
      fileChangeIdFor: (externalId: string) => this.normalizer.fileChangeIdFor(externalId)
    };
  }

  private scopeFromParams(params: Record<string, unknown>) {
    const threadId = textField(params, "threadId") ?? textField(params, "thread_id");
    const sessionId = threadId ? this.sessionsByThreadId.get(threadId) : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const externalTurnId = textField(params, "turnId") ?? textField(params, "turn_id");
    const turnId =
      externalTurnId && sessionId
        ? this.localTurnsByExternalTurnId.get(externalTurnId) ?? this.pendingLocalTurnsBySessionId.get(sessionId)
        : undefined;
    if (externalTurnId && turnId) {
      this.mapExternalTurn(externalTurnId, turnId);
    }
    return { projectId: session?.projectId, sessionId, turnId };
  }

  private learnExternalTurn(params: unknown): void {
    const payload = objectPayload(params);
    const threadId = textField(payload, "threadId") ?? textField(payload, "thread_id");
    const externalTurnId = textField(payload, "turnId") ?? textField(payload, "turn_id");
    if (!threadId || !externalTurnId || this.localTurnsByExternalTurnId.has(externalTurnId)) return;
    const sessionId = this.sessionsByThreadId.get(threadId);
    if (!sessionId) return;
    const localTurnId = this.pendingLocalTurnsBySessionId.get(sessionId);
    if (localTurnId) {
      this.mapExternalTurn(externalTurnId, localTurnId);
    }
  }

  private mapExternalTurn(externalTurnId: string, turnId: AgentTurnId): void {
    this.localTurnsByExternalTurnId.set(externalTurnId, turnId);
    this.externalTurnsByLocalTurnId.set(turnId, externalTurnId);
  }

  private providerSessionRef(threadId: string): ProviderSessionRef {
    return {
      providerId: this.id,
      externalId: threadId,
      externalKind: "thread",
      metadata: {
        transport: "stdio",
        schemaStrategy: schemaStrategy(this.command)
      }
    };
  }

  private registerSession(context: SessionContext): void {
    this.sessions.set(context.sessionId, context);
    this.sessionsByThreadId.set(context.threadId, context.sessionId);
  }

  private requireSession(sessionId: AgentSessionId): SessionContext {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Provider session is not known to the Codex app-server adapter.");
    }
    return session;
  }

  private sessionFromThread(thread: unknown, fallbackProjectId?: ProjectId): AgentSession | undefined {
    const payload = objectPayload(thread);
    const threadId = textField(payload, "threadId") ?? textField(payload, "id");
    const projectId = fallbackProjectId;
    if (!threadId || !projectId) return undefined;
    let sessionId = this.sessionsByThreadId.get(threadId);
    if (!sessionId) {
      sessionId = agentSessionId();
      this.registerSession({
        sessionId,
        projectId,
        threadId,
        cwd: textField(payload, "cwd") ?? ".",
        goal: textField(payload, "goal"),
        providerSessionRef: this.providerSessionRef(threadId)
      });
    }
    return this.agentSession(this.sessions.get(sessionId)!, "idle");
  }

  private agentSession(context: SessionContext, state: AgentSession["state"]): AgentSession {
    return {
      id: context.sessionId,
      projectId: context.projectId,
      providerId: this.id,
      providerSessionRef: context.providerSessionRef,
      cwd: context.cwd,
      state,
      goal: context.goal,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textField(value: unknown, key: string): string | undefined {
  const field = objectPayload(value)[key];
  return typeof field === "string" ? field : undefined;
}

function isApprovalRequestMethod(method: string): boolean {
  return [
    "commandExecution/approval",
    "commandExecution/requestApproval",
    "command/approval",
    "fileChange/approval",
    "fileChange/requestApproval"
  ].includes(method);
}

function approvalKind(method: string, params: Record<string, unknown>): ApprovalRequest["kind"] | undefined {
  if ("networkApprovalContext" in params) return "network";
  if (method.startsWith("fileChange")) return "file_change";
  if (method.startsWith("command") || method.startsWith("commandExecution")) return "command";
  return undefined;
}

function riskSignals(kind: ApprovalRequest["kind"], params: Record<string, unknown>): ApprovalRequest["riskSignals"] {
  if (kind === "network") return ["network_access"];
  if (kind === "file_change") return ["changes_multiple_projects"];
  const command = commandFromParams(params).join(" ");
  if (/git\s+(commit|push|reset|checkout)|rm\s+-rf/.test(command)) return ["modifies_git", "deletes_files"];
  return ["runs_package_script"];
}

function approvalTitle(kind: ApprovalRequest["kind"], params: Record<string, unknown>): string {
  if (kind === "network") return "Allow network access";
  if (kind === "file_change") return "Apply file change";
  return `Run command${commandFromParams(params)[0] ? `: ${commandFromParams(params)[0]}` : ""}`;
}

function approvalDescription(kind: ApprovalRequest["kind"], params: Record<string, unknown>): string {
  if (kind === "network") return "The provider requests network access for the active session.";
  if (kind === "file_change") return "The provider requests permission to apply a file change.";
  return `The provider requests permission to run ${commandFromParams(params).join(" ") || "a command"}.`;
}

function providerNeutralRequestedAction(kind: ApprovalRequest["kind"], params: Record<string, unknown>) {
  if (kind === "network") {
    const network = objectPayload(params.networkApprovalContext);
    return {
      network: {
        protocol: textField(network, "protocol"),
        host: textField(network, "host"),
        port: typeof network.port === "number" ? network.port : undefined
      }
    };
  }
  if (kind === "file_change") {
    return { path: textField(params, "path") ?? textField(params, "file"), diff: textField(params, "diff") };
  }
  return { command: commandFromParams(params), cwd: textField(params, "cwd") };
}

function commandFromParams(params: Record<string, unknown>): string[] {
  const command = params.command ?? params.argv;
  if (Array.isArray(command)) return command.map(String);
  if (typeof command === "string") return [command];
  return [];
}

function mapApprovalDecision(decision: ApprovalDecision): string | undefined {
  if (decision === "accept_once") return "accept";
  if (decision === "accept_for_session") return "acceptForSession";
  if (decision === "decline") return "decline";
  if (decision === "cancel") return "cancel";
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
