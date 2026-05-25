import type {
  AgentProvider,
  AgentRun,
  AgentRunStatus,
  AgentSession,
  AgentSessionId,
  AgentTurnId,
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
  ProjectArtifact,
  Project,
  ProjectId,
  ProjectProfile,
  ProjectRuntimeState,
  ProjectSource,
  ProjectWorkItem,
  Proposition,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderId,
  RiskLevel,
  RiskSignal
} from "../core";

export type ProviderSnapshot = {
  provider: AgentProvider;
  lastCheckedAt?: string;
  issues: string[];
};

export type ProjectSnapshot = {
  project: Project;
  profile: ProjectProfile;
  sources: ProjectSource[];
  artifacts: ProjectArtifact[];
  workItems: ProjectWorkItem[];
  agentRuns: AgentRun[];
  runtimeState: ProjectRuntimeState;
  git: GitSnapshot;
  reviewState: {
    readyToMergeMarkedAt?: string;
    acceptedOutOfDateBranch: boolean;
    statusHash?: string;
    evidence: EvidenceRef[];
  };
  sessions: Record<AgentSessionId, AgentSession>;
  turns: Record<string, AgentTurn>;
  approvals: ApprovalRequest[];
  commandRuns: CommandRun[];
  fileChanges: FileChange[];
  checkDefinitions: CheckDefinition[];
  checkRuns: CheckRun[];
  propositions: Proposition[];
  timelineSummary: {
    lastEventAt?: string;
    eventCount: number;
    latestEventTypes: string[];
  };
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

export type ProjectDiffFileViewModel = {
  path: string;
  oldPath?: string;
  changeKind: FileChange["changeKind"] | "binary";
  source: "provider" | "git";
  sourceSessionId?: AgentSessionId;
  sourceTurnId?: AgentTurnId;
  binary: boolean;
  summary: string;
  evidence: EvidenceRef[];
};

export type ProjectCardViewModel = {
  projectId: ProjectId;
  title: string;
  subtitle: string;
  profileFacets: string[];
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
  currentWorkItemTitle?: string;
  activeAgentCount: number;
  waitingAgentCount: number;
  blockedAgentCount: number;
  latestArtifactTitle?: string;
  reviewCheckStatus?: string;
  lastActivityAt?: string;
  badges: DashboardBadge[];
  primaryAction: DashboardAction;
  secondaryActions: DashboardAction[];
  diffFiles: ProjectDiffFileViewModel[];
  evidence: EvidenceRef[];
};

export type ApprovalCardViewModel = {
  approvalId: ApprovalRequestId;
  providerId: ProviderId;
  sessionId: AgentSessionId;
  workItemId?: string;
  agentRunId?: string;
  projectTitle: string;
  providerLabel: string;
  kind: ApprovalKind;
  risk: RiskLevel;
  riskSignals: RiskSignal[];
  title: string;
  summary: string;
  requestedAt: string;
  decisionOptions: { decision: ApprovalDecision; label: string; requiresConfirmation: boolean }[];
  evidence: EvidenceRef[];
};

export type AgentRunCardViewModel = {
  runId: AgentRun["id"];
  projectId: ProjectId;
  workItemId: AgentRun["workItemId"];
  roleName: string;
  rolePreset?: AgentRun["rolePreset"];
  providerLabel: string;
  providerId: ProviderId;
  linkedWorkItemTitle: string;
  status: AgentRunStatus;
  lastEvent?: string;
  pendingDecisionCount: number;
  pendingInput: boolean;
  producedArtifactCount: number;
  primaryAction: DashboardAction;
  evidence: EvidenceRef[];
  advanced: {
    sessionId?: AgentSessionId;
    providerSessionExternalKind?: string;
  };
};

export type ProjectWorkspaceViewModel = {
  projectId: ProjectId;
  header: {
    name: string;
    profileFacets: string[];
    state: ProjectRuntimeState;
    activeWorkCount: number;
    runningAgentCount: number;
    pendingDecisionCount: number;
    latestArtifact?: ProjectArtifact;
    primaryAction: DashboardAction;
  };
  workItems: {
    current: ProjectWorkItem[];
    queued: ProjectWorkItem[];
    blocked: ProjectWorkItem[];
    completed: ProjectWorkItem[];
  };
  agentBoard: Record<"queued" | "running" | "waiting" | "blocked" | "review" | "done", AgentRunCardViewModel[]>;
  sources: (ProjectSource & { usedByWorkItemIds: string[] })[];
  artifacts: ProjectArtifact[];
  decisions: ApprovalCardViewModel[];
  timeline: TimelineItemViewModel[];
};

export type HomeSectionItem = {
  id: string;
  projectId?: ProjectId;
  title: string;
  summary: string;
  action: DashboardAction;
  timestamp?: string;
};

export type HomeViewModel = {
  workInbox: HomeSectionItem[];
  activeProjects: ProjectCardViewModel[];
  waitingDecisions: ApprovalCardViewModel[];
  runningAgents: AgentRunCardViewModel[];
  blockedWork: HomeSectionItem[];
  readyToReview: ProjectCardViewModel[];
  recentArtifacts: ProjectArtifact[];
  quickCreate: DashboardAction[];
  questions: string[];
};

export type CheckRunViewModel = {
  runId: CheckRun["id"];
  checkId: CheckRun["checkId"];
  projectId: ProjectId;
  projectTitle: string;
  name: string;
  command: string[];
  status: CheckRun["status"];
  required: boolean;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  output: string;
  relatedFiles: string[];
  evidence: EvidenceRef[];
};

export type TimelineItemViewModel = {
  id: string;
  kind: "turn" | "message" | "command" | "file_change" | "approval" | "check" | "provider_error" | "system";
  eventType: string;
  projectId?: ProjectId;
  providerId?: ProviderId;
  sessionId?: AgentSessionId;
  turnId?: AgentTurnId;
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
  focusedProjectId?: ProjectId;
  home: HomeViewModel;
  selectedWorkspace?: ProjectWorkspaceViewModel;
  globalStatus: GlobalStatusViewModel;
  projectCards: ProjectCardViewModel[];
  approvals: ApprovalCardViewModel[];
  checkRuns: CheckRunViewModel[];
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
  focusedProjectId?: ProjectId;
  approvals: ApprovalQueueSnapshot;
  activeTurns: AgentTurn[];
  events: DomainEvent[];
  dashboard: DashboardProjection;
};
