import type {
  AgentSessionId,
  AgentTurnId,
  ApprovalRequestId,
  CheckDefinitionId,
  CheckRunId,
  CommandRunId,
  EventId,
  FileChangeId,
  PermissionProfileId,
  ProjectId,
  ProviderId
} from "./ids";

export type IsoTimestamp = string;

export type TruthValue = "true" | "false" | "unknown" | "stale";

export type EvidenceRef =
  | { type: "event"; eventId: EventId }
  | { type: "git"; repoPath: string; sha?: string; statusHash?: string }
  | { type: "check"; runId: CheckRunId; status: CheckRunStatus }
  | { type: "approval"; approvalId: ApprovalRequestId; decision?: ApprovalDecision }
  | { type: "provider"; providerId: ProviderId; externalId?: string }
  | { type: "user"; commandId: string };

export type Proposition = {
  id: string;
  subject: string;
  predicate: string;
  value: TruthValue;
  evidence: EvidenceRef[];
  checkedAt: IsoTimestamp;
};

export type GitRepositoryRef = {
  rootPath: string;
  remoteUrl?: string;
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type ProjectScript = {
  name: string;
  command: string[];
  source: "package_json" | "user" | "system";
  confidence: "high" | "medium" | "low";
};

export type ProjectMetadataFile = {
  path: string;
  kind: "package" | "workspace" | "project_config" | "other";
};

export type ProjectWorktree = {
  path: string;
  branch?: string;
  headSha?: string;
};

export type ProjectSettings = {
  defaultProviderId?: ProviderId;
  defaultPermissionProfileId?: PermissionProfileId;
  defaultCheckIds: string[];
  preferredWorktreeMode: "none" | "manual" | "task_isolated";
  autoRefreshGit: boolean;
  showInDashboard: boolean;
};

export const guardedPermissionProfileId = "permission_default" as PermissionProfileId;
export const fullAccessPermissionProfileId = "permission_full_access" as PermissionProfileId;

export const defaultProjectSettings: ProjectSettings = {
  defaultPermissionProfileId: guardedPermissionProfileId,
  defaultCheckIds: [],
  preferredWorktreeMode: "manual",
  autoRefreshGit: true,
  showInDashboard: true
};

export type Project = {
  id: ProjectId;
  name: string;
  rootPath: string;
  canonicalPath: string;
  repo?: GitRepositoryRef;
  defaultBranch?: string;
  packageManager?: PackageManager;
  scripts: ProjectScript[];
  metadataFiles: ProjectMetadataFile[];
  worktrees: ProjectWorktree[];
  tags: string[];
  settings: ProjectSettings;
  archived: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type ProviderCapabilities = {
  canStartSession: boolean;
  canResumeSession: boolean;
  canListSessions: boolean;
  canImportExistingSessions: boolean;
  canStreamEvents: boolean;
  canStreamTokenDeltas: boolean;
  canInterruptTurn: boolean;
  canSteerTurn: boolean;
  canRequestCommandApproval: boolean;
  canRequestFileApproval: boolean;
  canRunShellCommands: boolean;
  canEditFiles: boolean;
  canReportFileDiffs: boolean;
  canReportTokenUsage: boolean;
  canUseExternalTools: boolean;
  supportsSandboxing: boolean;
  supportsPermissionProfiles: boolean;
  supportsStructuredProtocol: boolean;
};

export type ProviderAvailability =
  | { status: "available"; version?: string; details?: Record<string, unknown> }
  | { status: "unavailable"; reason: string; details?: Record<string, unknown> }
  | {
      status: "incompatible";
      version?: string;
      reason: string;
      supportedVersions?: string;
      details?: Record<string, unknown>;
    };

export type ProviderStatus = ProviderAvailability["status"];

export type AgentProvider = {
  id: ProviderId;
  kind: string;
  displayName: string;
  adapterVersion: string;
  capabilities: ProviderCapabilities;
  availability: ProviderAvailability;
};

export type ProviderSessionRef = {
  providerId: ProviderId;
  externalId: string;
  externalKind?: string;
  metadata?: Record<string, unknown>;
};

export type AgentSessionState =
  | "created"
  | "starting"
  | "active"
  | "idle"
  | "waiting_for_approval"
  | "waiting_for_user_input"
  | "stale_or_disconnected"
  | "stopped"
  | "failed";

export type AgentSession = {
  id: AgentSessionId;
  projectId: ProjectId;
  providerId: ProviderId;
  providerSessionRef?: ProviderSessionRef;
  cwd: string;
  state: AgentSessionState;
  goal?: string;
  activeTurnId?: AgentTurnId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type AgentTurnStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type AgentTurn = {
  id: AgentTurnId;
  sessionId: AgentSessionId;
  projectId: ProjectId;
  providerId: ProviderId;
  status: AgentTurnStatus;
  inputSummary: string;
  startedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
};

export type ProjectRuntimeState =
  | "unregistered"
  | "idle"
  | "indexing"
  | "agent_starting"
  | "agent_ready"
  | "agent_planning"
  | "agent_running"
  | "waiting_for_approval"
  | "waiting_for_user_input"
  | "applying_changes"
  | "checks_running"
  | "checks_failed"
  | "dirty_worktree"
  | "reviewing_diff"
  | "ready_for_review"
  | "ready_to_merge"
  | "blocked"
  | "stale"
  | "unsafe_mode"
  | "error";

export type ApprovalKind =
  | "command"
  | "file_change"
  | "network"
  | "external_tool"
  | "dynamic_tool"
  | "user_input"
  | "permission_escalation";

export type ApprovalDecision = "accept_once" | "accept_for_session" | "decline" | "cancel";

export type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";

export type RiskSignal =
  | "writes_outside_workspace"
  | "network_access"
  | "deletes_files"
  | "modifies_git"
  | "reads_secret_like_file"
  | "runs_package_script"
  | "uses_full_access"
  | "touches_shell_config"
  | "touches_ci_config"
  | "touches_dependency_lockfile"
  | "changes_generated_files"
  | "changes_multiple_projects";

export type ApprovalRequest = {
  id: ApprovalRequestId;
  projectId: ProjectId;
  sessionId: AgentSessionId;
  turnId?: AgentTurnId;
  providerId: ProviderId;
  kind: ApprovalKind;
  risk: RiskLevel;
  riskSignals: RiskSignal[];
  title: string;
  description: string;
  requestedAction: unknown;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: IsoTimestamp;
  resolvedAt?: IsoTimestamp;
  decision?: ApprovalDecision;
  evidence: EvidenceRef[];
};

export type FileChange = {
  id: FileChangeId;
  projectId: ProjectId;
  sessionId?: AgentSessionId;
  turnId?: AgentTurnId;
  path: string;
  changeKind: "created" | "modified" | "deleted" | "renamed";
  status: "proposed" | "applied" | "rejected" | "reverted";
  diffRef?: string;
  evidence: EvidenceRef[];
};

export type CommandRun = {
  id: CommandRunId;
  projectId: ProjectId;
  sessionId?: AgentSessionId;
  turnId?: AgentTurnId;
  command: string[];
  cwd: string;
  status: "requested" | "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  stdoutRef?: string;
  stderrRef?: string;
};

export type CheckDefinition = {
  id: CheckDefinitionId;
  projectId: ProjectId;
  name: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  source: "detected" | "user" | "system";
};

export type CheckRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "waived";

export type CheckRun = {
  id: CheckRunId;
  checkId: CheckDefinitionId;
  projectId: ProjectId;
  status: CheckRunStatus;
  startedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
  exitCode?: number;
  stdoutRef?: string;
  stderrRef?: string;
  outputSummary?: string;
  waivedReason?: string;
  relatedFiles: string[];
};

export type GitSnapshot = {
  isRepo: boolean;
  branch?: string;
  headSha?: string;
  baseBranch?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  conflictedFiles: string[];
};

export type DomainEventSource = "user" | "agent" | "provider" | "git" | "check" | "system";

export type DomainEvent<TType extends string = string, TPayload = unknown> = {
  id: EventId;
  sequence?: number;
  type: TType;
  version: number;
  projectId?: ProjectId;
  sessionId?: AgentSessionId;
  turnId?: AgentTurnId;
  providerId?: ProviderId;
  timestamp: IsoTimestamp;
  source: DomainEventSource;
  causationId?: EventId;
  correlationId?: string;
  payload: TPayload;
  evidence: EvidenceRef[];
};

export type PermissionProfile = {
  id: PermissionProfileId;
  name: string;
  commandPolicy: "deny" | "ask" | "allow_limited" | "allow";
  fileWritePolicy: "deny" | "ask" | "workspace_only" | "allow";
  networkPolicy: "deny" | "ask" | "allow_list" | "allow";
  externalToolPolicy: "deny" | "ask" | "allow_list";
  maxRiskWithoutApproval: RiskLevel;
};

export type DashboardMode =
  | "portfolio"
  | "active_work"
  | "approval_center"
  | "failure_triage"
  | "diff_review"
  | "planning"
  | "stale_sessions"
  | "unsafe_attention"
  | "single_project_focus";
