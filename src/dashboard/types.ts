import type {
  AgentProvider,
  AgentSession,
  AgentSessionId,
  AgentTurn,
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRequestId,
  CheckDefinition,
  CheckRun,
  CommandRun,
  DashboardMode,
  DomainEvent,
  EvidenceRef,
  FileChange,
  GitSnapshot,
  Project,
  ProjectId,
  ProjectRuntimeState,
  Proposition,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderId,
  RiskLevel
} from "../core";

export type ProviderSnapshot = {
  provider: AgentProvider;
  lastCheckedAt?: string;
  issues: string[];
};

export type ProjectSnapshot = {
  project: Project;
  runtimeState: ProjectRuntimeState;
  git: GitSnapshot;
  sessions: Record<AgentSessionId, AgentSession>;
  turns: Record<string, AgentTurn>;
  approvals: ApprovalRequest[];
  commandRuns: CommandRun[];
  fileChanges: FileChange[];
  checkDefinitions: CheckDefinition[];
  checkRuns: CheckRun[];
  propositions: Proposition[];
  lastActivityAt?: string;
};

export type ApprovalQueueSnapshot = {
  pending: ApprovalRequest[];
  history: ApprovalRequest[];
};

export type DashboardAction = {
  id: string;
  label: string;
  method: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type DashboardBadge = {
  label: string;
  tone: "idle" | "active" | "waiting" | "review" | "passed" | "failed" | "blocked" | "stale" | "unsafe" | "unknown";
};

export type ProjectCardViewModel = {
  projectId: ProjectId;
  title: string;
  subtitle: string;
  runtimeState: ProjectRuntimeState;
  urgency: 0 | 1 | 2 | 3 | 4 | 5;
  stateLabel: string;
  stateReason: string;
  providerLabel?: string;
  branchLabel?: string;
  changedFileCount: number;
  pendingApprovalCount: number;
  failedCheckCount: number;
  activeTurnCount: number;
  lastActivityAt?: string;
  badges: DashboardBadge[];
  primaryAction: DashboardAction;
  secondaryActions: DashboardAction[];
  evidence: EvidenceRef[];
};

export type ApprovalCardViewModel = {
  approvalId: ApprovalRequestId;
  projectTitle: string;
  providerLabel: string;
  kind: ApprovalKind;
  risk: RiskLevel;
  title: string;
  summary: string;
  requestedAt: string;
  decisionOptions: { decision: ApprovalDecision; label: string; requiresConfirmation: boolean }[];
  evidence: EvidenceRef[];
};

export type TimelineItemViewModel = {
  id: string;
  kind: "turn" | "message" | "command" | "file_change" | "approval" | "check" | "provider_error" | "system";
  title: string;
  summary?: string;
  timestamp: string;
  status?: string;
  evidence: EvidenceRef[];
  expandable: boolean;
};

export type ProviderStatusViewModel = {
  providerId: ProviderId;
  name: string;
  availability: ProviderAvailability;
  capabilities: ProviderCapabilities;
  adapterVersion: string;
};

export type GlobalStatusViewModel = {
  activeProjectCount: number;
  activeTurnCount: number;
  pendingApprovalCount: number;
  failedCheckCount: number;
  staleSessionCount: number;
  unsafeStateCount: number;
  providerIssues: { providerId: ProviderId; message: string }[];
};

export type DashboardProjection = {
  mode: DashboardMode;
  globalStatus: GlobalStatusViewModel;
  projectCards: ProjectCardViewModel[];
  approvals: ApprovalCardViewModel[];
  providerStatus: ProviderStatusViewModel[];
  timeline: TimelineItemViewModel[];
  explanation: {
    mode: DashboardMode;
    propositions: Proposition[];
    evidence: EvidenceRef[];
  };
};

export type AppSnapshot = {
  projects: Record<ProjectId, ProjectSnapshot>;
  providers: Record<ProviderId, ProviderSnapshot>;
  approvals: ApprovalQueueSnapshot;
  activeTurns: AgentTurn[];
  events: DomainEvent[];
  dashboard: DashboardProjection;
};
