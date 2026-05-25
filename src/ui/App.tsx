import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Command,
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
  SlidersHorizontal,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ApprovalDecision, ApprovalRequestId, CheckRunId, EventId, EvidenceRef } from "../core";
import type {
  ApprovalCardViewModel,
  DashboardAction,
  CheckRunViewModel,
  DashboardProjection,
  ProjectCardViewModel,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "../dashboard/types";
import type { ObservabilityDiagnostics } from "../observability/ObservabilityService";
import { defaultAppSettings, type AppSettings } from "../settings/SettingsService";
import { callApi, decideApprovalThroughApi, subscribeDashboard, type ApiStatus } from "./apiClient";
import "./styles.css";

type Route = "Dashboard" | "Projects" | "Approvals" | "Activity" | "Checks" | "Providers" | "Settings";
type DetailFocusTarget = "project" | "evidence" | "diff";
type DetailFocusRequest = { target: DetailFocusTarget; nonce: number };

export function App() {
  const [route, setRoute] = useState<Route>("Dashboard");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("project-alpha");
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<string[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [detailFocusRequest, setDetailFocusRequest] = useState<DetailFocusRequest>({ target: "project", nonce: 0 });
  const [liveDashboard, setLiveDashboard] = useState<DashboardProjection | undefined>();
  const [apiStatus, setApiStatus] = useState<ApiStatus>("connecting");
  const fallbackDashboard = useMemo(() => demoDashboard(resolvedApprovalIds), [resolvedApprovalIds]);
  const dashboard = liveDashboard ?? fallbackDashboard;
  const selectedProject = dashboard.projectCards.find((project) => project.projectId === selectedProjectId);

  useEffect(() => {
    const controller = new AbortController();
    callApi<DashboardProjection>("dashboard.getSnapshot", undefined, controller.signal)
      .then((snapshot) => {
        setLiveDashboard(snapshot);
        setApiStatus("live");
        if (snapshot.projectCards[0]) {
          setSelectedProjectId(snapshot.projectCards[0].projectId);
        }
      })
      .catch(() => setApiStatus("fallback"));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (apiStatus !== "live") return undefined;
    return subscribeDashboard((snapshot) => {
      setLiveDashboard(snapshot);
      if (snapshot.projectCards[0] && !snapshot.projectCards.some((project) => project.projectId === selectedProjectId)) {
        setSelectedProjectId(snapshot.projectCards[0].projectId);
      }
    });
  }, [apiStatus, selectedProjectId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function decideApproval(approvalId: string, decision: ApprovalDecision) {
    const approval = dashboard.approvals.find((item) => item.approvalId === approvalId);
    const provider = dashboard.providerStatus[0];
    if (apiStatus === "live" && approval && provider) {
      await decideApprovalThroughApi({ providerId: provider.providerId, approvalId, decision }).catch(() => undefined);
      const snapshot = await callApi<DashboardProjection>("dashboard.getSnapshot").catch(() => undefined);
      if (snapshot) {
        setLiveDashboard(snapshot);
        return;
      }
    }
    setResolvedApprovalIds((current) => [...new Set([...current, approvalId])]);
  }

  function requestDetailFocus(target: DetailFocusTarget) {
    setDetailFocusRequest((current) => ({ target, nonce: current.nonce + 1 }));
  }

  function handleProjectAction(project: ProjectCardViewModel, action: DashboardAction) {
    if (action.disabled) return;
    setSelectedProjectId(project.projectId);
    if (action.id === "open-approvals") {
      setRoute("Approvals");
      return;
    }
    if (action.id === "run-checks" || action.id === "rerun-checks") {
      setRoute("Checks");
      return;
    }
    if (action.id === "mark-reviewed") {
      if (apiStatus === "live") {
        void callApi<unknown>("projects.markReadyToMerge", { projectId: project.projectId })
          .then(() => callApi<DashboardProjection>("dashboard.getSnapshot"))
          .then((snapshot) => {
            if (snapshot) setLiveDashboard(snapshot);
          })
          .catch(() => undefined);
      }
      requestDetailFocus("project");
      return;
    }
    if (action.id === "import-sessions") {
      const provider = dashboard.providerStatus.find((item) => item.name === project.providerLabel) ?? dashboard.providerStatus[0];
      if (apiStatus === "live" && provider) {
        void callApi<unknown>("agents.importSessions", { providerId: provider.providerId, projectId: project.projectId })
          .then(() => callApi<DashboardProjection>("dashboard.getSnapshot"))
          .then((snapshot) => {
            if (snapshot) setLiveDashboard(snapshot);
          })
          .catch(() => undefined);
      }
      requestDetailFocus("project");
      return;
    }
    if (action.id === "open-evidence") {
      requestDetailFocus("evidence");
      return;
    }
    if (action.id === "review-diff" || action.id === "open-diff") {
      requestDetailFocus("diff");
      return;
    }
    requestDetailFocus("project");
  }

  return (
    <main className={`appShell mode-${dashboard.mode}`}>
      <LeftNav route={route} dashboard={dashboard} onRoute={setRoute} />
      <section className="mainPanel" id="dashboard" aria-label={`${route} workspace`}>
        <TopBar dashboard={dashboard} apiStatus={apiStatus} onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
        {route === "Dashboard" && (
          <DashboardView
            dashboard={dashboard}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onProjectAction={handleProjectAction}
            onDecision={decideApproval}
          />
        )}
        {route === "Projects" && (
          <ProjectGrid
            dashboard={dashboard}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onProjectAction={handleProjectAction}
          />
        )}
        {route === "Approvals" && <ApprovalPanel approvals={dashboard.approvals} onDecision={decideApproval} />}
        {route === "Activity" && <ActivityTimeline items={dashboard.timeline} />}
        {route === "Checks" && <CheckRunPanel checkRuns={dashboard.checkRuns} />}
        {route === "Providers" && <ProviderGrid providers={dashboard.providerStatus} />}
        {route === "Settings" && <SettingsPanel apiStatus={apiStatus} onRoute={setRoute} />}
      </section>
      <DetailPanel dashboard={dashboard} selectedProject={selectedProject} focusRequest={detailFocusRequest} />
      {commandPaletteOpen ? (
        <CommandPalette
          dashboard={dashboard}
          onClose={() => setCommandPaletteOpen(false)}
          onRoute={(nextRoute) => {
            setRoute(nextRoute);
            setCommandPaletteOpen(false);
          }}
        />
      ) : null}
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

function TopBar({
  dashboard,
  apiStatus,
  onOpenCommandPalette
}: {
  dashboard: DashboardProjection;
  apiStatus: ApiStatus;
  onOpenCommandPalette(): void;
}) {
  return (
    <header className="topBar">
      <div>
        <p className="eyebrow">Provider-neutral control plane</p>
        <h1>{modeTitle(dashboard.mode)}</h1>
      </div>
      <div className="statusRail" aria-label="Global status">
        <button type="button" className="iconButton" aria-label="Open command palette" onClick={onOpenCommandPalette}>
          <Search size={16} aria-hidden="true" />
        </button>
        <span>
          <Activity size={16} /> {apiStatus === "live" ? "live runtime" : apiStatus === "fallback" ? "fallback state" : "connecting"}
        </span>
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
  onProjectAction,
  onDecision
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onProjectAction(project: ProjectCardViewModel, action: DashboardAction): void;
  onDecision(approvalId: string, decision: ApprovalDecision): void;
}) {
  if (dashboard.mode === "approval_center") {
    return (
      <div className="dashboardMode">
        <ApprovalPanel approvals={dashboard.approvals} onDecision={onDecision} />
        <ProjectGrid
          dashboard={dashboard}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onProjectAction={onProjectAction}
          compact
        />
      </div>
    );
  }

  if (dashboard.mode === "failure_triage") {
    return (
      <div className="dashboardMode">
        <FailureTriage />
        <ProjectGrid
          dashboard={dashboard}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onProjectAction={onProjectAction}
          compact
        />
      </div>
    );
  }

  return (
    <ProjectGrid
      dashboard={dashboard}
      selectedProjectId={selectedProjectId}
      onSelectProject={onSelectProject}
      onProjectAction={onProjectAction}
    />
  );
}

function ProjectGrid({
  dashboard,
  selectedProjectId,
  onSelectProject,
  onProjectAction,
  compact = false
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onProjectAction(project: ProjectCardViewModel, action: DashboardAction): void;
  compact?: boolean;
}) {
  const gridRef = useRef<HTMLElement>(null);

  function selectProjectByOffset(offset: number) {
    const currentIndex = Math.max(
      dashboard.projectCards.findIndex((project) => project.projectId === selectedProjectId),
      0
    );
    const nextProject = dashboard.projectCards[(currentIndex + offset + dashboard.projectCards.length) % dashboard.projectCards.length];
    if (!nextProject) return;
    onSelectProject(nextProject.projectId);
    window.requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-project-card="${nextProject.projectId}"]`)?.focus();
    });
  }

  function handleProjectGridKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (isEditableTarget(event.target) || dashboard.projectCards.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectProjectByOffset(1);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectProjectByOffset(-1);
    }
  }

  if (dashboard.projectCards.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Projects">
        <GitBranch size={28} aria-hidden="true" />
        <h2>No projects registered</h2>
        <p>Register a local project to start tracking sessions, approvals, file changes, checks, and review state.</p>
        <button type="button" data-method="projects.register">
          Register project
        </button>
      </section>
    );
  }

  return (
    <section
      ref={gridRef}
      className={compact ? "cardGrid compact" : "cardGrid"}
      aria-label="Projects"
      onKeyDown={handleProjectGridKeyDown}
    >
      {dashboard.projectCards.map((project) => (
        <ProjectCard
          key={project.projectId}
          project={project}
          selected={project.projectId === selectedProjectId}
          onOpenProject={() => onSelectProject(project.projectId)}
          onAction={(action) => onProjectAction(project, action)}
        />
      ))}
    </section>
  );
}

function ProjectCard({
  project,
  selected,
  onOpenProject,
  onAction
}: {
  project: ProjectCardViewModel;
  selected: boolean;
  onOpenProject(): void;
  onAction(action: DashboardAction): void;
}) {
  return (
    <article className={`projectCard urgency-${project.urgency} ${selected ? "selected" : ""}`}>
      <button
        type="button"
        className="cardHeader"
        onClick={onOpenProject}
        aria-pressed={selected}
        data-project-card={project.projectId}
      >
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
        <button
          type="button"
          data-method={project.primaryAction.method}
          disabled={project.primaryAction.disabled}
          title={project.primaryAction.disabledReason}
          onClick={() => onAction(project.primaryAction)}
        >
          {project.primaryAction.label}
        </button>
        {project.secondaryActions.map((action) => (
          <button
            key={action.id}
            type="button"
            data-method={action.method}
            disabled={action.disabled}
            title={action.disabledReason}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </article>
  );
}

type ApprovalDecisionOption = ApprovalCardViewModel["decisionOptions"][number];
type PendingApprovalDecision = {
  approval: ApprovalCardViewModel;
  option: ApprovalDecisionOption;
};

function ApprovalPanel({
  approvals,
  onDecision
}: {
  approvals: ApprovalCardViewModel[];
  onDecision(approvalId: string, decision: ApprovalDecision): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | undefined>(approvals[0]?.approvalId);
  const [pendingDecision, setPendingDecision] = useState<PendingApprovalDecision | undefined>();
  const selectedApproval = approvals.find((approval) => approval.approvalId === selectedApprovalId) ?? approvals[0];

  useEffect(() => {
    if (approvals.length === 0) {
      setSelectedApprovalId(undefined);
      setPendingDecision(undefined);
      return;
    }
    if (!selectedApprovalId || !approvals.some((approval) => approval.approvalId === selectedApprovalId)) {
      setSelectedApprovalId(approvals[0]?.approvalId);
    }
  }, [approvals, selectedApprovalId]);

  function requestDecision(approval: ApprovalCardViewModel, option: ApprovalDecisionOption) {
    if (option.requiresConfirmation) {
      setPendingDecision({ approval, option });
      return;
    }
    onDecision(approval.approvalId, option.decision);
  }

  function moveApprovalSelection(offset: number) {
    const currentIndex = Math.max(
      approvals.findIndex((approval) => approval.approvalId === selectedApproval?.approvalId),
      0
    );
    const nextApproval = approvals[(currentIndex + offset + approvals.length) % approvals.length];
    if (!nextApproval) return;
    setSelectedApprovalId(nextApproval.approvalId);
    window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(`[data-approval-card="${nextApproval.approvalId}"]`)?.focus();
    });
  }

  function handleApprovalKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (isEditableTarget(event.target) || approvals.length === 0 || pendingDecision) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      moveApprovalSelection(1);
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveApprovalSelection(-1);
    }
    if (event.key.toLowerCase() === "a" && selectedApproval) {
      const option = selectedApproval.decisionOptions.find((item) => item.decision === "accept_once");
      if (option) {
        event.preventDefault();
        requestDecision(selectedApproval, option);
      }
    }
    if (event.key.toLowerCase() === "d" && selectedApproval) {
      const option = selectedApproval.decisionOptions.find((item) => item.decision === "decline");
      if (option) {
        event.preventDefault();
        requestDecision(selectedApproval, option);
      }
    }
  }

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
    <section ref={panelRef} className="approvalPanel" aria-label="Approval center" tabIndex={0} onKeyDown={handleApprovalKeyDown}>
      <div className="sectionHeader">
        <ShieldAlert size={22} aria-hidden="true" />
        <div>
          <h2>Approval center</h2>
          <p>Review risk, evidence, and requested action before deciding.</p>
        </div>
      </div>
      {approvals.map((approval) => (
        <article
          key={approval.approvalId}
          className={`approvalCard risk-${approval.risk}`}
          data-approval-card={approval.approvalId}
          data-selected={approval.approvalId === selectedApproval?.approvalId ? "true" : undefined}
          tabIndex={approval.approvalId === selectedApproval?.approvalId ? 0 : -1}
          aria-label={`${approval.title}, ${approval.risk} risk`}
        >
          <div>
            <span className="stateBadge waiting">{approval.risk} risk</span>
            <h3>{approval.title}</h3>
            <p>{approval.summary}</p>
            {approval.riskSignals.length > 0 ? (
              <ul className="riskSignalList" aria-label="Risk signals">
                {approval.riskSignals.map((signal) => (
                  <li key={signal}>{signal.replaceAll("_", " ")}</li>
                ))}
              </ul>
            ) : null}
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
                <dt>Session</dt>
                <dd>{approval.sessionId}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{approval.kind.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>{approval.evidence.length} reference(s)</dd>
              </div>
            </dl>
          </div>
          <div className="decisionGrid">
            {approval.decisionOptions.map((option) => (
              <button
                key={option.decision}
                type="button"
                className={option.decision === "decline" ? "secondaryDanger" : undefined}
                data-method="agents.respondToApproval"
                data-decision={option.decision}
                onClick={() => requestDecision(approval, option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </article>
      ))}
      {pendingDecision ? (
        <DecisionConfirmationDialog
          pendingDecision={pendingDecision}
          onCancel={() => setPendingDecision(undefined)}
          onConfirm={() => {
            setPendingDecision(undefined);
            onDecision(pendingDecision.approval.approvalId, pendingDecision.option.decision);
          }}
        />
      ) : null}
    </section>
  );
}

function DecisionConfirmationDialog({
  pendingDecision,
  onCancel,
  onConfirm
}: {
  pendingDecision: PendingApprovalDecision;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="confirmationDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current, onCancel)}
      >
        <div>
          <span className="stateBadge waiting">{pendingDecision.approval.risk} risk</span>
          <h2 id="decision-confirmation-title">Confirm approval decision</h2>
          <p>
            {pendingDecision.option.label} for {pendingDecision.approval.title}. This decision will be stored before the
            provider receives a response.
          </p>
        </div>
        <dl className="approvalMeta">
          <div>
            <dt>Project</dt>
            <dd>{pendingDecision.approval.projectTitle}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{pendingDecision.approval.providerLabel}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{pendingDecision.approval.kind.replace("_", " ")}</dd>
          </div>
        </dl>
        <div className="actionRow">
          <button type="button" onClick={onCancel}>
            Keep pending
          </button>
          <button type="button" data-autofocus data-method="agents.respondToApproval" onClick={onConfirm}>
            Confirm decision
          </button>
        </div>
      </section>
    </div>
  );
}

function ProviderGrid({ providers }: { providers: ProviderStatusViewModel[] }) {
  if (providers.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Provider status">
        <SlidersHorizontal size={26} aria-hidden="true" />
        <h2>No providers configured</h2>
        <p>The fake provider remains available for development and test workflows without requiring a real runtime provider.</p>
        <button type="button" data-method="providers.list">
          Configure provider
        </button>
      </section>
    );
  }

  return (
    <section className="cardGrid" aria-label="Provider status">
      {providers.map((provider) => (
        <article className="providerStatusCard" key={provider.providerId}>
          <div className="sectionHeader">
            <SlidersHorizontal size={20} aria-hidden="true" />
            <div>
              <h2>{provider.name}</h2>
              <p>Adapter version {provider.adapterVersion}</p>
            </div>
          </div>
          <dl className="providerStatusGrid">
            <div>
              <dt>Availability</dt>
              <dd>
                <span className={`stateBadge ${provider.availability.status === "available" ? "passed" : "failed"}`}>
                  {provider.availability.status}
                </span>
              </dd>
            </div>
            <div>
              <dt>Compatibility</dt>
              <dd>
                <span className={`stateBadge ${provider.availability.status === "incompatible" ? "failed" : "passed"}`}>
                  {provider.availability.status === "incompatible" ? "incompatible" : "compatible"}
                </span>
              </dd>
            </div>
          </dl>
          {provider.availability.status !== "available" ? <p>{provider.availability.reason}</p> : null}
          <ul className="capabilityList" aria-label={`${provider.name} capabilities`}>
            {providerCapabilityBadges(provider).map((capability) => (
              <li key={capability.label} data-enabled={capability.enabled ? "true" : "false"}>
                <span>{capability.label}</span>
                <strong>{capability.enabled ? "supported" : "unavailable"}</strong>
              </li>
            ))}
          </ul>
          <div className="actionRow">
            <button type="button" data-method="providers.checkAvailability">
              Check availability
            </button>
            <button type="button" data-method="providers.getStatus">
              Configure provider
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function providerCapabilityBadges(provider: ProviderStatusViewModel): Array<{ label: string; enabled: boolean }> {
  return [
    { label: "Start sessions", enabled: provider.capabilities.canStartSession },
    { label: "Resume sessions", enabled: provider.capabilities.canResumeSession },
    { label: "Stream events", enabled: provider.capabilities.canStreamEvents },
    { label: "Interrupt turns", enabled: provider.capabilities.canInterruptTurn },
    { label: "Command approvals", enabled: provider.capabilities.canRequestCommandApproval },
    { label: "File approvals", enabled: provider.capabilities.canRequestFileApproval },
    { label: "Report file changes", enabled: provider.capabilities.canReportFileDiffs },
    { label: "Workspace permissions", enabled: provider.capabilities.supportsPermissionProfiles }
  ];
}

function ActivityTimeline({ items }: { items: TimelineItemViewModel[] }) {
  const [projectId, setProjectId] = useState("all");
  const [providerId, setProviderId] = useState("all");
  const [sessionId, setSessionId] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [expandedItemIds, setExpandedItemIds] = useState<string[]>([]);
  const projectOptions = optionsFor(items.map((item) => item.projectId));
  const providerOptions = optionsFor(items.map((item) => item.providerId));
  const sessionOptions = optionsFor(items.map((item) => item.sessionId));
  const eventTypeOptions = optionsFor(items.map((item) => item.eventType));
  const filteredItems = items.filter(
    (item) =>
      matchesFilter(item.projectId, projectId) &&
      matchesFilter(item.providerId, providerId) &&
      matchesFilter(item.sessionId, sessionId) &&
      matchesFilter(item.eventType, eventType)
  );
  const groups = timelineGroups(filteredItems);

  function toggleTimelineItem(itemId: string) {
    setExpandedItemIds((current) => (current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]));
  }

  return (
    <section className="timeline" aria-label="Activity timeline">
      <div className="timelineFilters" aria-label="Activity filters">
        <label>
          Project
          <select aria-label="Filter by project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="all">All projects</option>
            {projectOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select aria-label="Filter by provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            <option value="all">All providers</option>
            {providerOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Session
          <select aria-label="Filter by session" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            <option value="all">All sessions</option>
            {sessionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Event type
          <select aria-label="Filter by event type" value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option value="all">All event types</option>
            {eventTypeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      {groups.map((group) => (
        <section key={group.id} className="timelineGroup" aria-label={group.label}>
          <div className="timelineGroupHeader">
            <h2>{group.label}</h2>
            <span>{group.items.length} events</span>
          </div>
          {group.items.map((item) => {
            const expanded = expandedItemIds.includes(item.id);
            return (
              <article key={item.id} className={`timelineItem kind-${item.kind}`}>
                <span className="timelineIcon" aria-hidden="true">
                  {item.kind === "approval" ? <KeyRound size={16} /> : <Activity size={16} />}
                </span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.summary ?? item.status}</p>
                  <time>{new Date(item.timestamp).toLocaleTimeString()}</time>
                  <div className="timelineItemMeta">
                    <span>{item.kind.replace("_", " ")}</span>
                    {item.turnId ? <span>turn {item.turnId}</span> : null}
                    {item.sessionId ? <span>session {item.sessionId}</span> : null}
                  </div>
                  {item.expandable ? (
                    <button
                      type="button"
                      className="smallAction"
                      aria-expanded={expanded}
                      aria-controls={`timeline-details-${item.id}`}
                      onClick={() => toggleTimelineItem(item.id)}
                    >
                      {expanded ? "Hide details" : "Show details"}
                    </button>
                  ) : null}
                  {expanded ? (
                    <dl id={`timeline-details-${item.id}`} className="timelineDetails">
                      <div>
                        <dt>Event</dt>
                        <dd>{item.eventType}</dd>
                      </div>
                      <div>
                        <dt>Evidence</dt>
                        <dd>{item.evidence.length}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{item.status ?? "not reported"}</dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      ))}
      {filteredItems.length === 0 ? <p className="emptyText">No activity matches the selected filters.</p> : null}
    </section>
  );
}

function timelineGroups(items: TimelineItemViewModel[]): Array<{ id: string; label: string; items: TimelineItemViewModel[] }> {
  const groups = new Map<string, { id: string; label: string; items: TimelineItemViewModel[] }>();
  for (const item of items) {
    const id = item.turnId ?? item.sessionId ?? item.id;
    const label = item.turnId ? `Turn ${item.turnId}` : item.sessionId ? `Session ${item.sessionId}` : "System activity";
    const group = groups.get(id) ?? { id, label, items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function optionsFor(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function matchesFilter(value: string | undefined, filter: string): boolean {
  return filter === "all" || value === filter;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement | null, onClose: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

type CommandItem = {
  id: string;
  label: string;
  method: string;
  route: Route;
  disabled?: boolean;
};

function CommandPalette({
  dashboard,
  onClose,
  onRoute
}: {
  dashboard: DashboardProjection;
  onClose(): void;
  onRoute(route: Route): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const commands: CommandItem[] = [
    { id: "register-project", label: "Register project", method: "projects.register", route: "Projects" },
    {
      id: "start-agent-task",
      label: "Start agent task",
      method: "agents.startSession",
      route: "Dashboard",
      disabled: dashboard.providerStatus.every((provider) => !provider.capabilities.canStartSession)
    },
    { id: "open-approvals", label: "Open approvals", method: "agents.respondToApproval", route: "Approvals" },
    { id: "run-checks", label: "Run checks", method: "checks.run", route: "Checks" },
    { id: "open-diff-review", label: "Open diff review", method: "git.openDiff", route: "Dashboard" },
    { id: "explain-dashboard-mode", label: "Explain dashboard mode", method: "dashboard.explainMode", route: "Dashboard" },
    { id: "show-provider-status", label: "Show provider status", method: "providers.getStatus", route: "Providers" },
    { id: "open-event-log", label: "Open event log", method: "events.query", route: "Activity" }
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = commands.filter(
    (command) =>
      normalizedQuery.length === 0 ||
      command.label.toLowerCase().includes(normalizedQuery) ||
      command.method.toLowerCase().includes(normalizedQuery)
  );

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="commandPalette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current, onClose)}
      >
        <div className="commandSearch">
          <Command size={18} aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands"
          />
          <button type="button" className="iconButton" aria-label="Close command palette" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="commandList" role="listbox" aria-label="Commands">
          {filtered.map((command) => (
            <button
              key={command.id}
              type="button"
              role="option"
              data-method={command.method}
              disabled={command.disabled}
              onClick={() => onRoute(command.route)}
            >
              <span>{command.label}</span>
              <small>{command.method}</small>
            </button>
          ))}
          {filtered.length === 0 ? <p className="emptyText">No commands match the search.</p> : null}
        </div>
      </section>
    </div>
  );
}

function CheckRunPanel({ checkRuns }: { checkRuns: CheckRunViewModel[] }) {
  const activeRuns = checkRuns.filter((run) => run.status === "queued" || run.status === "running");
  const recentRuns = checkRuns.filter((run) => run.status !== "queued" && run.status !== "running");

  if (checkRuns.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Check runs">
        <ListChecks size={26} aria-hidden="true" />
        <h2>No checks have run</h2>
        <p>Add a check or use detected project scripts to validate changes before review.</p>
        <button type="button" data-method="checks.list">
          Add check
        </button>
      </section>
    );
  }

  return (
    <section className="checkRunPanel" aria-label="Check runs">
      <div className="sectionHeader">
        <ListChecks size={22} aria-hidden="true" />
        <div>
          <h2>Check runs</h2>
          <p>Active and recent checks with command output linked to changed files.</p>
        </div>
      </div>
      <div className="checkRunGroups">
        <CheckRunGroup title="Active" runs={activeRuns} emptyText="No active check runs." />
        <CheckRunGroup title="Recent" runs={recentRuns} emptyText="No recent check runs." />
      </div>
      <button type="button" data-method="checks.run">
        Run checks
      </button>
    </section>
  );
}

function CheckRunGroup({ title, runs, emptyText }: { title: string; runs: CheckRunViewModel[]; emptyText: string }) {
  return (
    <section className="checkRunGroup" aria-label={`${title} check runs`}>
      <h3>{title}</h3>
      {runs.map((run) => (
        <article key={run.runId} className={`checkRunCard status-${run.status}`}>
          <div className="checkRunHeader">
            <div>
              <span className={`stateBadge ${checkRunTone(run.status)}`}>
                {run.status}
              </span>
              {run.required ? <span className="stateBadge waiting">required</span> : null}
              <h4>{run.name}</h4>
              <p>{run.projectTitle}</p>
            </div>
            <div className="checkActions">
              <button type="button" data-method={run.status === "running" ? "checks.cancel" : "checks.run"}>
                {run.status === "running" ? "Cancel" : "Rerun"}
              </button>
              {run.status === "failed" && run.required ? (
                <button type="button" data-method="checks.waive">
                  Waive
                </button>
              ) : null}
            </div>
          </div>
          <dl className="checkMeta">
            <div>
              <dt>Command</dt>
              <dd>
                <code>{run.command.length > 0 ? run.command.join(" ") : "not recorded"}</code>
              </dd>
            </div>
            <div>
              <dt>Exit code</dt>
              <dd>{run.exitCode ?? "pending"}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(run.durationMs)}</dd>
            </div>
          </dl>
          {run.output ? <pre tabIndex={0}>{run.output}</pre> : <p className="emptyText">No output captured.</p>}
          <div className="triageFiles" aria-label="Failed check triage files">
            {run.relatedFiles.length > 0 ? (
              run.relatedFiles.map((file) => (
                <a key={`${run.runId}-${file}`} href={`#${file}`} data-method="git.openDiff">
                  {file}
                </a>
              ))
            ) : (
              <span>No changed files linked.</span>
            )}
          </div>
        </article>
      ))}
      {runs.length === 0 ? <p className="emptyText">{emptyText}</p> : null}
    </section>
  );
}

function checkRunTone(status: CheckRunViewModel["status"]): string {
  if (status === "failed") return "failed";
  if (status === "passed" || status === "waived") return "passed";
  return "active";
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "running";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function FailureTriage() {
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  return (
    <section className="splitPanel">
      <div>
        <div className="sectionHeader">
          <AlertTriangle size={22} aria-hidden="true" />
          <h2>Failure triage</h2>
        </div>
        <p>One required check failed after file changes. Review the output before asking the agent to continue.</p>
        <div className="actionRow">
          <button type="button" data-method="checks.run">
            Rerun failed checks
          </button>
          <button type="button" data-method="agents.sendTurn">
            Send instruction
          </button>
          <button type="button" className="secondaryDanger" data-method="git.discardChanges" onClick={() => setConfirmDiscardOpen(true)}>
            Discard changes
          </button>
        </div>
      </div>
      <pre tabIndex={0}>Changed file: src/example.ts{"\n"}Output: expected fake assertion to pass</pre>
      {confirmDiscardOpen ? <DiscardChangesDialog onCancel={() => setConfirmDiscardOpen(false)} /> : null}
    </section>
  );
}

function DiscardChangesDialog({ onCancel }: { onCancel(): void }) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="confirmationDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current, onCancel)}
      >
        <div>
          <span className="stateBadge failed">destructive</span>
          <h2 id="discard-confirmation-title">Confirm discard</h2>
          <p>Discard selected git changes only after reviewing the diff and check output.</p>
        </div>
        <div className="actionRow">
          <button type="button" onClick={onCancel}>
            Keep changes
          </button>
          <button type="button" data-autofocus data-method="git.discardChanges" onClick={onCancel}>
            Confirm discard
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({ apiStatus, onRoute }: { apiStatus: ApiStatus; onRoute(route: Route): void }) {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [diagnostics, setDiagnostics] = useState<ObservabilityDiagnostics>(demoDiagnostics());
  const [debugExportPreviewOpen, setDebugExportPreviewOpen] = useState(false);
  const [pendingRawLogChange, setPendingRawLogChange] = useState(false);
  const [message, setMessage] = useState("Settings are ready.");

  useEffect(() => {
    const controller = new AbortController();
    callApi<AppSettings>("settings.get", undefined, controller.signal)
      .then((nextSettings) => {
        setSettings(nextSettings);
        setMessage("Settings loaded from the local runtime.");
      })
      .catch(() => {
        setSettings(defaultAppSettings);
        setMessage("Settings preview is using local defaults.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    callApi<ObservabilityDiagnostics>("diagnostics.get", undefined, controller.signal)
      .then((nextDiagnostics) => setDiagnostics(nextDiagnostics))
      .catch(() => setDiagnostics(demoDiagnostics()));
    return () => controller.abort();
  }, []);

  async function updateSettings(patch: Partial<AppSettings>, confirmRawProviderLogs = false) {
    const fallback = mergeSettings(settings, patch);
    if (apiStatus === "live") {
      const nextSettings = await callApi<AppSettings>("settings.update", { patch, confirmRawProviderLogs }).catch(() => undefined);
      if (nextSettings) {
        setSettings(nextSettings);
        setMessage("Settings saved to the local runtime.");
        return;
      }
    }
    setSettings(fallback);
    setMessage("Settings updated in the preview state.");
  }

  async function confirmRawLogs() {
    setPendingRawLogChange(false);
    await updateSettings({ rawProviderLogsEnabled: true }, true);
  }

  return (
    <section className="settingsPanel" aria-label="Settings panel">
      <div className="sectionHeader">
        <Settings size={22} aria-hidden="true" />
        <div>
          <h2>Settings</h2>
          <p>{message}</p>
        </div>
      </div>
      <section className="settingsGroup" aria-label="App settings">
        <h3>App settings</h3>
        <dl className="settingsGrid">
          <div>
            <dt>Runtime</dt>
            <dd>{apiStatus === "live" ? "live runtime" : apiStatus === "fallback" ? "preview defaults" : "connecting"}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>
              <code>{settings.databasePath}</code>
            </dd>
          </div>
          <div>
            <dt>Telemetry</dt>
            <dd>{settings.telemetryMode.replaceAll("_", " ")}</dd>
          </div>
        </dl>
      </section>
      <section className="settingsGroup" aria-label="Permission profiles">
        <h3>Permission profiles</h3>
        <p>Guarded workspace permissions are the default. Broad access requires explicit confirmation at the project level.</p>
        <span className="stateBadge passed">guarded default</span>
      </section>
      <section className="settingsGroup" aria-label="Logging">
        <div className="settingsHeaderRow">
          <div>
            <h3>Logging</h3>
            <p>Raw provider logs are disabled by default and require confirmation before enabling.</p>
          </div>
          <span className={`stateBadge ${settings.rawProviderLogsEnabled ? "unsafe" : "passed"}`}>
            {settings.rawProviderLogsEnabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="actionRow">
          {settings.rawProviderLogsEnabled ? (
            <button type="button" data-method="settings.update" onClick={() => updateSettings({ rawProviderLogsEnabled: false })}>
              Disable raw provider logs
            </button>
          ) : (
            <button type="button" data-method="settings.update" onClick={() => setPendingRawLogChange(true)}>
              Enable raw provider logs
            </button>
          )}
        </div>
      </section>
      <section className="settingsGroup" aria-label="Project discovery">
        <h3>Project discovery</h3>
        {settings.projectRoots.length > 0 ? (
          <ul className="settingsList">
            {settings.projectRoots.map((root) => (
              <li key={root}>
                <code>{root}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No project roots configured.</p>
        )}
        <button type="button" data-method="settings.update" onClick={() => updateSettings({ projectRoots: settings.projectRoots })}>
          Save project roots
        </button>
      </section>
      <section className="settingsGroup" aria-label="Provider settings placement">
        <h3>Provider settings</h3>
        <p>Provider-specific configuration lives under Providers so project settings remain provider-neutral.</p>
        <button type="button" data-method="providers.getStatus" onClick={() => onRoute("Providers")}>
          Open provider status
        </button>
      </section>
      <section className="settingsGroup" aria-label="Plugin settings">
        <h3>Plugin settings</h3>
        <p>Plugin changes are guarded by permissions and provider-adapter contract validation.</p>
        <button type="button" data-method="events.query" onClick={() => onRoute("Activity")}>
          Inspect plugin activity
        </button>
      </section>
      <section className="settingsGroup" aria-label="Diagnostics">
        <div className="settingsHeaderRow">
          <div>
            <h3>Diagnostics</h3>
            <p>Review logs, events, projection evidence, safety output, metrics, and replay health before exporting debug data.</p>
          </div>
          <span className={`stateBadge ${diagnostics.replay.status === "ok" ? "passed" : "failed"}`}>
            replay {diagnostics.replay.status}
          </span>
        </div>
        <dl className="settingsGrid">
          <div>
            <dt>Provider log</dt>
            <dd>{diagnostics.providerLog.length}</dd>
          </div>
          <div>
            <dt>Event log</dt>
            <dd>{diagnostics.eventLog.length}</dd>
          </div>
          <div>
            <dt>API samples</dt>
            <dd>{diagnostics.metrics.apiLatencyMs.count}</dd>
          </div>
        </dl>
        <div className="actionRow">
          <button
            type="button"
            data-method="diagnostics.get"
            aria-expanded={debugExportPreviewOpen}
            onClick={() => setDebugExportPreviewOpen((open) => !open)}
          >
            Review debug export
          </button>
        </div>
        {debugExportPreviewOpen ? <DebugExportPreview diagnostics={diagnostics} rawProviderLogsEnabled={settings.rawProviderLogsEnabled} /> : null}
      </section>
      {pendingRawLogChange ? (
        <SettingsConfirmationDialog onCancel={() => setPendingRawLogChange(false)} onConfirm={confirmRawLogs} />
      ) : null}
    </section>
  );
}

function DebugExportPreview({
  diagnostics,
  rawProviderLogsEnabled
}: {
  diagnostics: ObservabilityDiagnostics;
  rawProviderLogsEnabled: boolean;
}) {
  const truePropositions = diagnostics.propositionInspector.true.length;
  const falsePropositions = diagnostics.propositionInspector.false.length;
  const unknownPropositions = diagnostics.propositionInspector.unknown.length;
  const stalePropositions = diagnostics.propositionInspector.stale.length;

  return (
    <section className="debugExportPreview" aria-label="Debug export preview">
      <h4>Debug export preview</h4>
      <ul className="settingsList">
        <li>Provider log: {diagnostics.providerLog.length} redacted entries.</li>
        <li>Event log: {diagnostics.eventLog.length} normalized events.</li>
        <li>Projection inspector: {diagnostics.projectionInspector.projectStates.length} project states with evidence.</li>
        <li>
          Proposition inspector: {truePropositions} true, {falsePropositions} false, {unknownPropositions} unknown, {stalePropositions} stale.
        </li>
        <li>Safety inspector: {diagnostics.safetyInspector.pendingApprovals.length} pending approvals and policy outputs.</li>
        <li>Metrics: event ingestion, projection timing, provider latency, approval wait, turn, command, check, and API latency summaries.</li>
        <li>Replay health: {diagnostics.replay.status}.</li>
        <li>{rawProviderLogsEnabled ? "Raw provider logs included after redaction." : "Raw provider logs excluded by current settings."}</li>
      </ul>
      {diagnostics.providerLog[0] ? <p>{diagnostics.providerLog[0].message}</p> : null}
    </section>
  );
}

function SettingsConfirmationDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="confirmationDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current, onCancel)}
      >
        <div>
          <span className="stateBadge unsafe">logging risk</span>
          <h2 id="settings-confirmation-title">Confirm logging change</h2>
          <p>Raw provider logs can include sensitive runtime data. Logs remain redacted, but this setting is still stored only after confirmation.</p>
        </div>
        <div className="actionRow">
          <button type="button" onClick={onCancel}>
            Keep disabled
          </button>
          <button type="button" data-autofocus data-method="settings.update" onClick={onConfirm}>
            Enable raw logs
          </button>
        </div>
      </section>
    </div>
  );
}

function mergeSettings(settings: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...settings,
    ...patch,
    enabledProviderIds: [...(patch.enabledProviderIds ?? settings.enabledProviderIds)],
    projectRoots: [...(patch.projectRoots ?? settings.projectRoots)]
  };
}

function demoDiagnostics(): ObservabilityDiagnostics {
  const now = new Date().toISOString();
  return {
    providerLog: [
      {
        eventId: "event-provider-error" as EventId,
        providerId: "fake" as ProviderStatusViewModel["providerId"],
        level: "error",
        message: "Provider error [REDACTED]",
        timestamp: now,
        raw: false
      }
    ],
    eventLog: [
      {
        eventId: "event-approval" as EventId,
        sequence: 1,
        type: "approval.requested",
        projectId: "project-alpha" as ProjectCardViewModel["projectId"],
        providerId: "fake" as ProviderStatusViewModel["providerId"],
        sessionId: "session-alpha" as TimelineItemViewModel["sessionId"],
        timestamp: now,
        source: "provider",
        evidence: [{ type: "event", eventId: "event-approval" as EventId }],
        payload: { redacted: true }
      }
    ],
    projectionInspector: {
      dashboardMode: "approval_center",
      projectStates: [
        {
          projectId: "project-alpha",
          state: "waiting_for_approval",
          evidence: [{ type: "event", eventId: "event-approval" as EventId }]
        }
      ],
      evidenceEventIds: ["event-approval"]
    },
    propositionInspector: {
      true: [
        {
          id: "demo:pending-approval",
          subject: "project-alpha",
          predicate: "has_pending_approval",
          value: "true",
          evidence: [{ type: "event", eventId: "event-approval" as EventId }],
          checkedAt: now
        }
      ],
      false: [],
      unknown: [],
      stale: []
    },
    safetyInspector: {
      permissionProfile: {
        id: defaultAppSettings.defaultPermissionProfileId,
        name: "Workspace guarded",
        commandPolicy: "ask",
        fileWritePolicy: "workspace_only",
        networkPolicy: "ask",
        externalToolPolicy: "ask",
        maxRiskWithoutApproval: "low"
      },
      rawProviderLogsEnabled: false,
      pendingApprovals: [
        {
          approvalId: "approval-alpha" as ApprovalRequestId,
          risk: "high",
          riskSignals: ["runs_package_script"],
          requiresApproval: true
        }
      ],
      pluginRiskRules: [],
      policyOutputs: [{ subject: "approval-alpha", requiresApproval: true, reason: "Risk exceeds the configured permission profile." }]
    },
    metrics: {
      eventIngestion: [],
      projectionTimings: [],
      providerEventIngestionLatencyMs: emptyStats(),
      approvalWaitTimeMs: emptyStats(),
      agentTurnDurationMs: emptyStats(),
      commandDurationMs: emptyStats(),
      checkDurationMs: emptyStats(),
      apiLatencyMs: emptyStats(),
      staleSessionCount: 0
    },
    replay: {
      status: "ok",
      checkedAt: now,
      durationMs: 0,
      eventCount: 1,
      differences: []
    }
  };
}

function emptyStats() {
  return { count: 0, min: 0, max: 0, avg: 0, latest: 0 };
}

function DetailPanel({
  dashboard,
  selectedProject,
  focusRequest
}: {
  dashboard: DashboardProjection;
  selectedProject?: ProjectCardViewModel;
  focusRequest: DetailFocusRequest;
}) {
  const projectRef = useRef<HTMLElement>(null);
  const evidenceRef = useRef<HTMLElement>(null);
  const diffRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusRequest.nonce === 0) return;
    const target = {
      project: projectRef.current,
      evidence: evidenceRef.current,
      diff: diffRef.current
    }[focusRequest.target];
    target?.focus();
  }, [focusRequest]);

  const relevantPropositions = selectedProject
    ? dashboard.explanation.propositions.filter(
        (proposition) => proposition.subject === selectedProject.projectId || proposition.subject === "dashboard"
      )
    : dashboard.explanation.propositions;

  return (
    <aside className="detailPanel" aria-label="Details">
      <section
        ref={projectRef}
        aria-label="Project details"
        tabIndex={-1}
        data-active={focusRequest.target === "project" ? "true" : undefined}
      >
        <h2>Selected project</h2>
        {selectedProject ? (
          <>
            <p>{selectedProject.title}</p>
            <span className={`stateBadge ${selectedProject.badges[0]?.tone ?? "unknown"}`}>{selectedProject.stateLabel}</span>
            <p>{selectedProject.stateReason}</p>
            <dl className="metricGrid">
              <div>
                <dt>Files</dt>
                <dd>{selectedProject.changedFileCount}</dd>
              </div>
              <div>
                <dt>Approvals</dt>
                <dd>{selectedProject.pendingApprovalCount}</dd>
              </div>
              <div>
                <dt>Checks</dt>
                <dd>{selectedProject.failedCheckCount}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p>No project selected.</p>
        )}
      </section>
      <section
        ref={evidenceRef}
        aria-label="Project evidence"
        tabIndex={-1}
        data-active={focusRequest.target === "evidence" ? "true" : undefined}
      >
        <h2>Explain state</h2>
        <p>
          {selectedProject ? `Evidence for ${selectedProject.title}. ` : ""}
          {modeTitle(dashboard.mode)} is selected from project state, approvals, checks, risk, and recency.
        </p>
        <ul className="evidenceList" aria-label="Propositions">
          {relevantPropositions.slice(0, 5).map((proposition) => (
            <li key={proposition.id}>
              <span>{proposition.predicate.replaceAll("_", " ")}</span>
              <strong>{proposition.value}</strong>
              <small>{proposition.evidence.length} evidence refs</small>
            </li>
          ))}
        </ul>
        {selectedProject ? <EvidenceList evidence={selectedProject.evidence} /> : null}
      </section>
      <section
        ref={diffRef}
        aria-label="Diff review details"
        tabIndex={-1}
        data-active={focusRequest.target === "diff" ? "true" : undefined}
      >
        <h2>Diff review</h2>
        <DiffReviewPanel selectedProject={selectedProject} />
      </section>
    </aside>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  if (evidence.length === 0) {
    return <p className="emptyText">No evidence references recorded.</p>;
  }

  return (
    <ul className="evidenceRefList" aria-label="Evidence references">
      {evidence.map((item, index) => (
        <li key={`${item.type}-${index}`}>
          <span>{formatEvidenceRef(item)}</span>
        </li>
      ))}
    </ul>
  );
}

function formatEvidenceRef(evidence: EvidenceRef): string {
  if (evidence.type === "event") return `Event ${evidence.eventId}`;
  if (evidence.type === "check") return `Check ${evidence.runId} ${evidence.status}`;
  if (evidence.type === "approval") return `Approval ${evidence.approvalId}${evidence.decision ? ` ${evidence.decision}` : ""}`;
  if (evidence.type === "git") return `Git ${evidence.sha ?? evidence.statusHash ?? evidence.repoPath}`;
  if (evidence.type === "provider") return `Provider ${evidence.providerId}${evidence.externalId ? ` ${evidence.externalId}` : ""}`;
  return `User ${evidence.commandId}`;
}

function DiffReviewPanel({ selectedProject }: { selectedProject?: ProjectCardViewModel }) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | undefined>(selectedProject?.diffFiles[0]?.path);
  const diffFiles = selectedProject?.diffFiles ?? [];
  const filteredFiles = diffFiles.filter((file) => file.path.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedFile =
    filteredFiles.find((file) => file.path === selectedPath) ?? filteredFiles[0] ?? diffFiles.find((file) => file.path === selectedPath);

  useEffect(() => {
    setSelectedPath(selectedProject?.diffFiles[0]?.path);
  }, [selectedProject?.projectId, selectedProject?.diffFiles]);

  if (!selectedProject || diffFiles.length === 0) {
    return (
      <div className="diffPreview emptyDiff" role="region" aria-label="Diff preview" tabIndex={0}>
        <p>No diff files available.</p>
      </div>
    );
  }

  return (
    <div className="diffViewer" role="region" aria-label="Diff preview">
      <label>
        File search
        <input
          aria-label="Search diff files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files"
        />
      </label>
      <div className="diffViewerBody">
        <div className="diffFileList" role="listbox" aria-label="Diff files">
          {filteredFiles.map((file) => (
            <button
              key={`${file.oldPath ?? ""}:${file.path}`}
              type="button"
              role="option"
              aria-selected={file.path === selectedFile?.path}
              data-kind={file.changeKind}
              onClick={() => setSelectedPath(file.path)}
            >
              <span>{file.changeKind}</span>
              <code>{file.path}</code>
            </button>
          ))}
          {filteredFiles.length === 0 ? <p className="emptyText">No diff files match the search.</p> : null}
        </div>
        {selectedFile ? (
          <div className="diffPreview" tabIndex={0}>
            <span>{selectedFile.changeKind}</span>
            {selectedFile.oldPath ? (
              <p>
                <code>{selectedFile.oldPath}</code> renamed to <code>{selectedFile.path}</code>
              </p>
            ) : (
              <code>{selectedFile.path}</code>
            )}
            <dl className="diffMeta">
              <div>
                <dt>Source</dt>
                <dd>{selectedFile.source}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>{selectedFile.sourceSessionId ?? "not linked"}</dd>
              </div>
              <div>
                <dt>Turn</dt>
                <dd>{selectedFile.sourceTurnId ?? "not linked"}</dd>
              </div>
            </dl>
            {selectedFile.binary ? (
              <p>Binary file metadata only.</p>
            ) : (
              <pre>{selectedFile.summary}</pre>
            )}
          </div>
        ) : null}
      </div>
    </div>
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
  const alphaEvidence: EvidenceRef[] = [
    { type: "event", eventId: "event-approval" as EventId },
    { type: "approval", approvalId: "approval-alpha" as ApprovalRequestId }
  ];
  const betaEvidence: EvidenceRef[] = [
    { type: "event", eventId: "event-check" as EventId },
    { type: "check", runId: "check-run-beta" as CheckRunId, status: "failed" }
  ];
  const approvals: ApprovalCardViewModel[] = resolvedApprovalIds.includes("approval-alpha")
    ? []
    : [
        {
          approvalId: "approval-alpha" as ApprovalCardViewModel["approvalId"],
          sessionId: "session-alpha" as ApprovalCardViewModel["sessionId"],
          projectTitle: "Control Plane",
          providerLabel: "Fake provider",
          kind: "command",
          risk: "high",
          riskSignals: ["runs_package_script"],
          title: "Run project command",
          summary: "The agent requests permission to run a required project check.",
          requestedAt: now,
          decisionOptions: [
            { decision: "accept_once", label: "Accept once", requiresConfirmation: true },
            { decision: "accept_for_session", label: "Accept for session", requiresConfirmation: true },
            { decision: "decline", label: "Decline", requiresConfirmation: false },
            { decision: "cancel", label: "Cancel", requiresConfirmation: false }
          ],
          evidence: alphaEvidence
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
        : { id: "mark-reviewed", label: "Mark reviewed", method: "projects.markReadyToMerge" },
      secondaryActions: [{ id: "open-evidence", label: "Open evidence", method: "dashboard.explainMode" }],
      diffFiles: [
        {
          path: "src/new-file.ts",
          changeKind: "created",
          source: "provider",
          sourceSessionId: "session-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceSessionId"],
          sourceTurnId: "turn-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceTurnId"],
          binary: false,
          summary: "+export const value = 1;",
          evidence: alphaEvidence
        },
        {
          path: "assets/logo.bin",
          changeKind: "binary",
          source: "git",
          binary: true,
          summary: "Binary file metadata only.",
          evidence: alphaEvidence
        },
        {
          path: "src/current-name.ts",
          oldPath: "src/old-name.ts",
          changeKind: "renamed",
          source: "provider",
          sourceSessionId: "session-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceSessionId"],
          sourceTurnId: "turn-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceTurnId"],
          binary: false,
          summary: "Renamed file from src/old-name.ts.",
          evidence: alphaEvidence
        }
      ],
      evidence: alphaEvidence
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
      secondaryActions: [
        { id: "open-evidence", label: "Open evidence", method: "dashboard.explainMode" },
        { id: "open-diff", label: "Open diff review", method: "git.openDiff" }
      ],
      diffFiles: [
        {
          path: "package.json",
          changeKind: "modified",
          source: "git",
          binary: false,
          summary: "Changed package metadata.",
          evidence: betaEvidence
        }
      ],
      evidence: betaEvidence
    }
  ];

  return {
    mode,
    projectCards,
    approvals,
    checkRuns: [
      {
        runId: "check-run-beta" as CheckRunViewModel["runId"],
        checkId: "check-definition-beta" as CheckRunViewModel["checkId"],
        projectId: "project-beta" as CheckRunViewModel["projectId"],
        projectTitle: "Package Metadata",
        name: "test",
        command: ["npm", "test"],
        status: "failed",
        required: true,
        startedAt: now,
        completedAt: now,
        durationMs: 1240,
        exitCode: 1,
        output: "src/example.ts: expected value to pass",
        relatedFiles: ["src/example.ts", "package.json"],
        evidence: betaEvidence
      },
      {
        runId: "check-run-alpha" as CheckRunViewModel["runId"],
        checkId: "check-definition-alpha" as CheckRunViewModel["checkId"],
        projectId: "project-alpha" as CheckRunViewModel["projectId"],
        projectTitle: "Control Plane",
        name: "typecheck",
        command: ["npm", "run", "typecheck"],
        status: "running",
        required: false,
        startedAt: now,
        output: "",
        relatedFiles: [],
        evidence: alphaEvidence
      }
    ],
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
      },
      {
        providerId: "unavailable-demo" as ProviderStatusViewModel["providerId"],
        name: "Unavailable provider",
        adapterVersion: "0.1.0",
        availability: { status: "unavailable", reason: "Provider is not configured." },
        capabilities: {
          canStartSession: false,
          canResumeSession: false,
          canListSessions: false,
          canImportExistingSessions: false,
          canStreamEvents: false,
          canStreamTokenDeltas: false,
          canInterruptTurn: false,
          canSteerTurn: false,
          canRequestCommandApproval: false,
          canRequestFileApproval: false,
          canRunShellCommands: false,
          canEditFiles: false,
          canReportFileDiffs: false,
          canReportTokenUsage: false,
          canUseExternalTools: false,
          supportsSandboxing: false,
          supportsPermissionProfiles: false,
          supportsStructuredProtocol: false
        }
      }
    ],
    timeline: [
      {
        id: "event-approval",
        kind: "approval",
        eventType: "approval.requested",
        projectId: "project-alpha" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-alpha" as TimelineItemViewModel["sessionId"],
        turnId: "turn-alpha" as TimelineItemViewModel["turnId"],
        title: "approval.requested",
        summary: "Run project command",
        timestamp: now,
        status: "pending",
        evidence: alphaEvidence,
        expandable: true
      },
      {
        id: "event-turn",
        kind: "turn",
        eventType: "agent.turn.started",
        projectId: "project-alpha" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-alpha" as TimelineItemViewModel["sessionId"],
        turnId: "turn-alpha" as TimelineItemViewModel["turnId"],
        title: "agent.turn.started",
        summary: "Run the check",
        timestamp: now,
        status: "in_progress",
        evidence: alphaEvidence,
        expandable: true
      },
      {
        id: "event-command",
        kind: "command",
        eventType: "agent.command.failed",
        projectId: "project-beta" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-beta" as TimelineItemViewModel["sessionId"],
        turnId: "turn-beta" as TimelineItemViewModel["turnId"],
        title: "agent.command.failed",
        summary: "npm test exited with code 1",
        timestamp: now,
        status: "failed",
        evidence: betaEvidence,
        expandable: true
      },
      {
        id: "event-file",
        kind: "file_change",
        eventType: "agent.fileChange.proposed",
        projectId: "project-alpha" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-alpha" as TimelineItemViewModel["sessionId"],
        turnId: "turn-alpha" as TimelineItemViewModel["turnId"],
        title: "agent.fileChange.proposed",
        summary: "src/new-file.ts",
        timestamp: now,
        status: "proposed",
        evidence: alphaEvidence,
        expandable: true
      },
      {
        id: "event-check",
        kind: "check",
        eventType: "check.failed",
        projectId: "project-beta" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-beta" as TimelineItemViewModel["sessionId"],
        turnId: "turn-beta" as TimelineItemViewModel["turnId"],
        title: "check.failed",
        summary: "test",
        timestamp: now,
        status: "failed",
        evidence: betaEvidence,
        expandable: true
      },
      {
        id: "event-provider-error",
        kind: "provider_error",
        eventType: "provider.error",
        projectId: "project-beta" as TimelineItemViewModel["projectId"],
        providerId: "fake" as TimelineItemViewModel["providerId"],
        sessionId: "session-beta" as TimelineItemViewModel["sessionId"],
        turnId: "turn-beta" as TimelineItemViewModel["turnId"],
        title: "provider.error",
        summary: "Provider disconnected",
        timestamp: now,
        status: "error",
        evidence: betaEvidence,
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
      evidence: [...alphaEvidence, ...betaEvidence],
      propositions: [
        {
          id: "dash-approval",
          subject: "dashboard",
          predicate: "pending_approval_outranks_active_work",
          value: approvals.length > 0 ? "true" : "false",
          evidence: alphaEvidence,
          checkedAt: now
        },
        {
          id: "dash-checks",
          subject: "project-beta",
          predicate: "failed_required_check_blocks_review",
          value: "true",
          evidence: betaEvidence,
          checkedAt: now
        }
      ]
    }
  };
}
