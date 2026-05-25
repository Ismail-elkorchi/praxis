import type {
  AgentSession,
  AgentSessionId,
  AgentTurnId,
  ApprovalDecision,
  ApprovalRequestId,
  DomainEvent,
  ProjectId,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderId,
  ProviderSessionRef
} from "../../core";

export type StartSessionInput = {
  sessionId?: AgentSessionId;
  projectId: ProjectId;
  cwd: string;
  goal?: string;
};

export type StartSessionResult = {
  sessionId?: AgentSessionId;
  providerSessionRef?: ProviderSessionRef;
  events: DomainEvent[];
};

export type ResumeSessionInput = {
  sessionId: AgentSessionId;
};

export type ResumeSessionResult = {
  events: DomainEvent[];
};

export type StopSessionInput = {
  sessionId: AgentSessionId;
  reason?: string;
};

export type SendTurnInput = {
  turnId?: AgentTurnId;
  sessionId: AgentSessionId;
  projectId: ProjectId;
  input: string;
};

export type SendTurnResult = {
  turnId?: AgentTurnId;
  events: DomainEvent[];
};

export type SteerTurnInput = {
  sessionId: AgentSessionId;
  turnId: AgentTurnId;
  input: string;
};

export type InterruptTurnInput = {
  sessionId: AgentSessionId;
  turnId: AgentTurnId;
  reason?: string;
};

export type ApprovalDecisionInput = {
  approvalId: ApprovalRequestId;
  sessionId: AgentSessionId;
  decision: ApprovalDecision;
};

export type UserInputDecisionInput = {
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
  input: string;
};

export type ReadSessionInput = {
  sessionId: AgentSessionId;
};

export type AgentSessionSnapshot = {
  session: AgentSession;
  events: DomainEvent[];
};

export type ListSessionsInput = {
  projectId?: ProjectId;
  cursor?: string;
  limit?: number;
};

export type AgentSessionListPage = {
  sessions: AgentSession[];
  nextCursor?: string;
};

export type ImportSessionsInput = {
  projectId?: ProjectId;
};

export type ImportedProviderSession = {
  providerSessionRef: ProviderSessionRef;
  snapshot?: AgentSessionSnapshot;
};

export type WatchProviderEventsInput = {
  sessionId?: AgentSessionId;
  sinceSequence?: number;
};

export type ProviderRuntimeEvent = DomainEvent;

export interface ProviderAdapter {
  id: ProviderId;
  kind: string;
  displayName: string;
  adapterVersion: string;

  getCapabilities(): Promise<ProviderCapabilities>;
  checkAvailability(): Promise<ProviderAvailability>;
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  resumeSession?(input: ResumeSessionInput): Promise<ResumeSessionResult>;
  stopSession(input: StopSessionInput): Promise<void>;
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
  steerTurn?(input: SteerTurnInput): Promise<void>;
  interruptTurn?(input: InterruptTurnInput): Promise<void>;
  respondToApproval(input: ApprovalDecisionInput): Promise<void>;
  respondToUserInput?(input: UserInputDecisionInput): Promise<void>;
  readSession?(input: ReadSessionInput): Promise<AgentSessionSnapshot>;
  listSessions?(input: ListSessionsInput): Promise<AgentSessionListPage>;
  importSessions?(input: ImportSessionsInput): AsyncIterable<ImportedProviderSession>;
  watchEvents(input: WatchProviderEventsInput): AsyncIterable<ProviderRuntimeEvent>;
  shutdown?(): Promise<void> | void;
}
