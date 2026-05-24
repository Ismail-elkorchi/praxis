import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileDiff,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  PauseCircle,
  Play,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ApprovalDecision } from "../core";
import type {
  ApprovalCardViewModel,
  DashboardProjection,
  ProjectCardViewModel,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "../dashboard/types";
import "./styles.css";

type Route = "Dashboard" | "Projects" | "Approvals" | "Activity" | "Checks" | "Providers" | "Settings";

export function App() {
  const [route, setRoute] = useState<Route>("Dashboard");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("project-alpha");
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<string[]>([]);
  const dashboard = useMemo(() => demoDashboard(resolvedApprovalIds), [resolvedApprovalIds]);
  const selectedProject = dashboard.projectCards.find((project) => project.projectId === selectedProjectId);

  function decideApproval(approvalId: string, _decision: ApprovalDecision) {
    setResolvedApprovalIds((current) => [...new Set([...current, approvalId])]);
  }

  return (
    <main className={`appShell mode-${dashboard.mode}`}>
      <LeftNav route={route} dashboard={dashboard} onRoute={setRoute} />
      <section className="mainPanel" id="dashboard" aria-label={`${route} workspace`}>
        <TopBar dashboard={dashboard} />
        {route === "Dashboard" && (
          <DashboardView
            dashboard={dashboard}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onDecision={decideApproval}
          />
        )}
        {route === "Projects" && (
          <ProjectGrid dashboard={dashboard} selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId} />
        )}
        {route === "Approvals" && <ApprovalPanel approvals={dashboard.approvals} onDecision={decideApproval} />}
        {route === "Activity" && <ActivityTimeline items={dashboard.timeline} />}
        {route === "Checks" && <CheckRunPanel />}
        {route === "Providers" && <ProviderGrid providers={dashboard.providerStatus} />}
        {route === "Settings" && <SettingsPanel />}
      </section>
      <DetailPanel dashboard={dashboard} selectedProject={selectedProject} />
    </main>
  );
}

function LeftNav({
  route,
  dashboard,
  onRoute
}: {
  route: Route;
  dashboard: DashboardProjection;
  onRoute(route: Route): void;
}) {
  const routes: { label: Route; icon: typeof LayoutDashboard; badge?: number }[] = [
    { label: "Dashboard", icon: LayoutDashboard },
    { label: "Projects", icon: GitBranch, badge: dashboard.projectCards.length },
    { label: "Approvals", icon: ShieldCheck, badge: dashboard.globalStatus.pendingApprovalCount },
    { label: "Activity", icon: Activity, badge: dashboard.globalStatus.activeTurnCount },
    { label: "Checks", icon: ListChecks, badge: dashboard.globalStatus.failedCheckCount },
    { label: "Providers", icon: SlidersHorizontal, badge: dashboard.globalStatus.providerIssues.length },
    { label: "Settings", icon: Settings }
  ];

  return (
    <nav className="leftNav" aria-label="Primary">
      <strong>Praxis</strong>
      {routes.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            className={route === item.label ? "navItem active" : "navItem"}
            onClick={() => onRoute(item.label)}
            aria-current={route === item.label ? "page" : undefined}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{item.label}</span>
            {item.badge ? <span className="navBadge">{item.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

function TopBar({ dashboard }: { dashboard: DashboardProjection }) {
  return (
    <header className="topBar">
      <div>
        <p className="eyebrow">Provider-neutral control plane</p>
        <h1>{modeTitle(dashboard.mode)}</h1>
      </div>
      <div className="statusRail" aria-label="Global status">
        <span>
          <Activity size={16} /> {dashboard.globalStatus.activeTurnCount} active turns
        </span>
        <span>
          <ShieldCheck size={16} /> {dashboard.globalStatus.pendingApprovalCount} approvals
        </span>
        <span>
          <CheckCircle2 size={16} /> {dashboard.globalStatus.failedCheckCount} failed checks
        </span>
      </div>
    </header>
  );
}

function DashboardView({
  dashboard,
  selectedProjectId,
  onSelectProject,
  onDecision
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onDecision(approvalId: string, decision: ApprovalDecision): void;
}) {
  if (dashboard.mode === "approval_center") {
    return (
      <div className="dashboardMode">
        <ApprovalPanel approvals={dashboard.approvals} onDecision={onDecision} />
        <ProjectGrid dashboard={dashboard} selectedProjectId={selectedProjectId} onSelectProject={onSelectProject} compact />
      </div>
    );
  }

  if (dashboard.mode === "failure_triage") {
    return (
      <div className="dashboardMode">
        <FailureTriage />
        <ProjectGrid dashboard={dashboard} selectedProjectId={selectedProjectId} onSelectProject={onSelectProject} compact />
      </div>
    );
  }

  return <ProjectGrid dashboard={dashboard} selectedProjectId={selectedProjectId} onSelectProject={onSelectProject} />;
}

function ProjectGrid({
  dashboard,
  selectedProjectId,
  onSelectProject,
  compact = false
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  compact?: boolean;
}) {
  return (
    <section className={compact ? "cardGrid compact" : "cardGrid"} aria-label="Projects">
      {dashboard.projectCards.map((project) => (
        <ProjectCard
          key={project.projectId}
          project={project}
          selected={project.projectId === selectedProjectId}
          onOpenProject={() => onSelectProject(project.projectId)}
        />
      ))}
    </section>
  );
}

function ProjectCard({
  project,
  selected,
  onOpenProject
}: {
  project: ProjectCardViewModel;
  selected: boolean;
  onOpenProject(): void;
}) {
  return (
    <article className={`projectCard urgency-${project.urgency} ${selected ? "selected" : ""}`}>
      <button type="button" className="cardHeader" onClick={onOpenProject}>
        <span>
          <strong>{project.title}</strong>
          <small>{project.branchLabel ?? "No branch"}</small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      <div className="stateRow">
        {project.badges.map((badge) => (
          <span key={`${project.projectId}-${badge.label}`} className={`stateBadge ${badge.tone}`}>
            {badge.label}
          </span>
        ))}
      </div>
      <p>{project.stateReason}</p>
      <dl className="metricGrid">
        <div>
          <dt>Files</dt>
          <dd>{project.changedFileCount}</dd>
        </div>
        <div>
          <dt>Approvals</dt>
          <dd>{project.pendingApprovalCount}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>{project.failedCheckCount}</dd>
        </div>
      </dl>
      <div className="actionRow">
        <button type="button" disabled={project.primaryAction.disabled} title={project.primaryAction.disabledReason}>
          {project.primaryAction.label}
        </button>
        <button type="button">Explain state</button>
      </div>
    </article>
  );
}

function ApprovalPanel({
  approvals,
  onDecision
}: {
  approvals: ApprovalCardViewModel[];
  onDecision(approvalId: string, decision: ApprovalDecision): void;
}) {
  if (approvals.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Approval center">
        <ShieldCheck size={26} aria-hidden="true" />
        <h2>No pending approvals</h2>
        <p>Recent decisions remain available in the activity timeline.</p>
      </section>
    );
  }

  return (
    <section className="approvalPanel" aria-label="Approval center">
      <div className="sectionHeader">
        <ShieldAlert size={22} aria-hidden="true" />
        <div>
          <h2>Approval center</h2>
          <p>Review risk, evidence, and requested action before deciding.</p>
        </div>
      </div>
      {approvals.map((approval) => (
        <article key={approval.approvalId} className={`approvalCard risk-${approval.risk}`}>
          <div>
            <span className="stateBadge waiting">{approval.risk} risk</span>
            <h3>{approval.title}</h3>
            <p>{approval.summary}</p>
            <dl className="approvalMeta">
              <div>
                <dt>Project</dt>
                <dd>{approval.projectTitle}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{approval.providerLabel}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{approval.kind.replace("_", " ")}</dd>
              </div>
            </dl>
          </div>
          <div className="decisionGrid">
            {approval.decisionOptions.map((option) => (
              <button
                key={option.decision}
                type="button"
                className={option.decision === "decline" ? "secondaryDanger" : undefined}
                onClick={() => onDecision(approval.approvalId, option.decision)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function ProviderGrid({ providers }: { providers: ProviderStatusViewModel[] }) {
  return (
    <section className="cardGrid" aria-label="Provider status">
      {providers.map((provider) => (
        <article className="projectCard" key={provider.providerId}>
          <div className="sectionHeader">
            <SlidersHorizontal size={20} aria-hidden="true" />
            <div>
              <h2>{provider.name}</h2>
              <p>Adapter version {provider.adapterVersion}</p>
            </div>
          </div>
          <span className={`stateBadge ${provider.availability.status === "available" ? "passed" : "failed"}`}>
            {provider.availability.status}
          </span>
          <p>Capabilities determine which session, turn, approval, and interrupt actions are available.</p>
          <button type="button">Check availability</button>
        </article>
      ))}
    </section>
  );
}

function ActivityTimeline({ items }: { items: TimelineItemViewModel[] }) {
  return (
    <section className="timeline" aria-label="Activity timeline">
      {items.map((item) => (
        <article key={item.id} className="timelineItem">
          <span className="timelineIcon" aria-hidden="true">
            {item.kind === "approval" ? <KeyRound size={16} /> : <Activity size={16} />}
          </span>
          <div>
            <h3>{item.title}</h3>
            <p>{item.summary ?? item.status}</p>
            <time>{new Date(item.timestamp).toLocaleTimeString()}</time>
          </div>
        </article>
      ))}
    </section>
  );
}

function CheckRunPanel() {
  return (
    <section className="splitPanel">
      <div>
        <h2>Failed check triage</h2>
        <p>Failed output is linked to changed files and source turns.</p>
        <button type="button">Rerun failed checks</button>
      </div>
      <pre tabIndex={0}>src/example.ts: expected value to pass</pre>
    </section>
  );
}

function FailureTriage() {
  return (
    <section className="splitPanel">
      <div>
        <div className="sectionHeader">
          <AlertTriangle size={22} aria-hidden="true" />
          <h2>Failure triage</h2>
        </div>
        <p>One required check failed after file changes. Review the output before asking the agent to continue.</p>
        <div className="actionRow">
          <button type="button">Rerun failed checks</button>
          <button type="button">Send instruction</button>
        </div>
      </div>
      <pre tabIndex={0}>Changed file: src/example.ts{"\n"}Output: expected fake assertion to pass</pre>
    </section>
  );
}

function SettingsPanel() {
  return (
    <section className="settingsPanel">
      <h2>Settings</h2>
      <label>
        <input type="checkbox" />
        Enable raw provider logs
      </label>
      <label>
        <input type="checkbox" defaultChecked />
        Use guarded workspace permissions by default
      </label>
    </section>
  );
}

function DetailPanel({
  dashboard,
  selectedProject
}: {
  dashboard: DashboardProjection;
  selectedProject?: ProjectCardViewModel;
}) {
  return (
    <aside className="detailPanel" aria-label="Details">
      <section>
        <h2>Explain state</h2>
        <p>{modeTitle(dashboard.mode)} is selected from project state, approvals, checks, risk, and recency.</p>
        <ul className="evidenceList">
          {dashboard.explanation.propositions.slice(0, 5).map((proposition) => (
            <li key={proposition.id}>
              <span>{proposition.predicate.replaceAll("_", " ")}</span>
              <strong>{proposition.value}</strong>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Selected project</h2>
        {selectedProject ? (
          <>
            <p>{selectedProject.title}</p>
            <span className={`stateBadge ${selectedProject.badges[0]?.tone ?? "unknown"}`}>{selectedProject.stateLabel}</span>
          </>
        ) : (
          <p>No project selected.</p>
        )}
      </section>
      <section>
        <h2>Diff review</h2>
        <div className="diffPreview" role="region" aria-label="Diff preview" tabIndex={0}>
          <span>created</span>
          <code>src/new-file.ts</code>
          <pre>+export const value = 1;</pre>
        </div>
      </section>
    </aside>
  );
}

function modeTitle(mode: DashboardProjection["mode"]) {
  return {
    portfolio: "Portfolio",
    active_work: "Active work",
    approval_center: "Approval center",
    failure_triage: "Failure triage",
    diff_review: "Diff review",
    planning: "Planning",
    stale_sessions: "Stale sessions",
    unsafe_attention: "Unsafe attention",
    single_project_focus: "Project focus"
  }[mode];
}

function demoDashboard(resolvedApprovalIds: string[]): DashboardProjection {
  const now = new Date().toISOString();
  const approvals: ApprovalCardViewModel[] = resolvedApprovalIds.includes("approval-alpha")
    ? []
    : [
        {
          approvalId: "approval-alpha" as ApprovalCardViewModel["approvalId"],
          projectTitle: "Control Plane",
          providerLabel: "Fake provider",
          kind: "command",
          risk: "high",
          title: "Run project command",
          summary: "The agent requests permission to run a required project check.",
          requestedAt: now,
          decisionOptions: [
            { decision: "accept_once", label: "Accept once", requiresConfirmation: true },
            { decision: "accept_for_session", label: "Accept for session", requiresConfirmation: true },
            { decision: "decline", label: "Decline", requiresConfirmation: false },
            { decision: "cancel", label: "Cancel", requiresConfirmation: false }
          ],
          evidence: []
        }
      ];
  const mode = approvals.length > 0 ? "approval_center" : "diff_review";
  const projectCards: ProjectCardViewModel[] = [
    {
      projectId: "project-alpha" as ProjectCardViewModel["projectId"],
      title: "Control Plane",
      subtitle: "Local project",
      runtimeState: approvals.length > 0 ? "waiting_for_approval" : "ready_for_review",
      urgency: approvals.length > 0 ? 4 : 2,
      stateLabel: approvals.length > 0 ? "Waiting for approval" : "Ready for review",
      stateReason: approvals.length > 0 ? "1 approval request needs a decision." : "2 changed files are ready for review.",
      providerLabel: "Fake provider",
      branchLabel: "feature/provider-neutral",
      changedFileCount: 2,
      pendingApprovalCount: approvals.length,
      failedCheckCount: 0,
      activeTurnCount: 1,
      lastActivityAt: now,
      badges: approvals.length > 0 ? [{ label: "Approval pending", tone: "waiting" }] : [{ label: "Review", tone: "review" }],
      primaryAction: approvals.length > 0
        ? { id: "open-approvals", label: "Open approvals", method: "agents.respondToApproval" }
        : { id: "review-diff", label: "Review diff", method: "git.openDiff" },
      secondaryActions: [{ id: "explain-state", label: "Explain state", method: "dashboard.explainMode" }],
      evidence: []
    },
    {
      projectId: "project-beta" as ProjectCardViewModel["projectId"],
      title: "Package Metadata",
      subtitle: "Local project",
      runtimeState: "checks_failed",
      urgency: 3,
      stateLabel: "Checks failed",
      stateReason: "1 required check failed.",
      providerLabel: "Fake provider",
      branchLabel: "main",
      changedFileCount: 1,
      pendingApprovalCount: 0,
      failedCheckCount: 1,
      activeTurnCount: 0,
      badges: [{ label: "Required check failed", tone: "failed" }],
      primaryAction: { id: "rerun-checks", label: "Rerun failed checks", method: "checks.run" },
      secondaryActions: [{ id: "open-diff", label: "Open diff review", method: "git.openDiff" }],
      evidence: []
    }
  ];

  return {
    mode,
    projectCards,
    approvals,
    providerStatus: [
      {
        providerId: "fake" as ProviderStatusViewModel["providerId"],
        name: "Fake provider",
        adapterVersion: "0.1.0",
        availability: { status: "available", version: "0.1.0" },
        capabilities: {
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
        }
      }
    ],
    timeline: [
      {
        id: "event-approval",
        kind: "approval",
        title: "approval.requested",
        summary: "Run project command",
        timestamp: now,
        status: "pending",
        evidence: [],
        expandable: true
      },
      {
        id: "event-turn",
        kind: "turn",
        title: "agent.turn.started",
        summary: "Run the check",
        timestamp: now,
        status: "in_progress",
        evidence: [],
        expandable: true
      }
    ],
    globalStatus: {
      activeProjectCount: 2,
      activeTurnCount: approvals.length > 0 ? 1 : 0,
      pendingApprovalCount: approvals.length,
      failedCheckCount: 1,
      staleSessionCount: 0,
      unsafeStateCount: 0,
      providerIssues: []
    },
    explanation: {
      mode,
      evidence: [],
      propositions: [
        {
          id: "dash-approval",
          subject: "dashboard",
          predicate: "pending_approval_outranks_active_work",
          value: approvals.length > 0 ? "true" : "false",
          evidence: [],
          checkedAt: now
        },
        {
          id: "dash-checks",
          subject: "project-beta",
          predicate: "failed_required_check_blocks_review",
          value: "true",
          evidence: [],
          checkedAt: now
        }
      ]
    }
  };
}
