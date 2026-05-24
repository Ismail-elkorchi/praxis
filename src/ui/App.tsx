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
import type { ApprovalDecision } from "../core";
import type {
  ApprovalCardViewModel,
  CheckRunViewModel,
  DashboardProjection,
  ProjectCardViewModel,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "../dashboard/types";
import { callApi, decideApprovalThroughApi, subscribeDashboard, type ApiStatus } from "./apiClient";
import "./styles.css";

type Route = "Dashboard" | "Projects" | "Approvals" | "Activity" | "Checks" | "Providers" | "Settings";

export function App() {
  const [route, setRoute] = useState<Route>("Dashboard");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("project-alpha");
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<string[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
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
            onDecision={decideApproval}
          />
        )}
        {route === "Projects" && (
          <ProjectGrid dashboard={dashboard} selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId} />
        )}
        {route === "Approvals" && <ApprovalPanel approvals={dashboard.approvals} onDecision={decideApproval} />}
        {route === "Activity" && <ActivityTimeline items={dashboard.timeline} />}
        {route === "Checks" && <CheckRunPanel checkRuns={dashboard.checkRuns} />}
        {route === "Providers" && <ProviderGrid providers={dashboard.providerStatus} />}
        {route === "Settings" && <SettingsPanel />}
      </section>
      <DetailPanel dashboard={dashboard} selectedProject={selectedProject} />
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
        >
          {project.primaryAction.label}
        </button>
        {project.secondaryActions.map((action) => (
          <button key={action.id} type="button" data-method={action.method} disabled={action.disabled} title={action.disabledReason}>
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
          <button type="button" data-method="providers.checkAvailability">
            Check availability
          </button>
        </article>
      ))}
    </section>
  );
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
              <span className={`stateBadge ${run.status === "failed" ? "failed" : run.status === "passed" ? "passed" : "active"}`}>
                {run.status}
              </span>
              {run.required ? <span className="stateBadge waiting">required</span> : null}
              <h4>{run.name}</h4>
              <p>{run.projectTitle}</p>
            </div>
            <button type="button" data-method={run.status === "running" ? "checks.cancel" : "checks.run"}>
              {run.status === "running" ? "Cancel" : "Rerun"}
            </button>
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

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "running";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
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
          <button type="button" data-method="checks.run">
            Rerun failed checks
          </button>
          <button type="button" data-method="agents.sendTurn">
            Send instruction
          </button>
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
        <DiffReviewPanel selectedProject={selectedProject} />
      </section>
    </aside>
  );
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
  const approvals: ApprovalCardViewModel[] = resolvedApprovalIds.includes("approval-alpha")
    ? []
    : [
        {
          approvalId: "approval-alpha" as ApprovalCardViewModel["approvalId"],
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
      diffFiles: [
        {
          path: "src/new-file.ts",
          changeKind: "created",
          source: "provider",
          sourceSessionId: "session-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceSessionId"],
          sourceTurnId: "turn-alpha" as ProjectCardViewModel["diffFiles"][number]["sourceTurnId"],
          binary: false,
          summary: "+export const value = 1;",
          evidence: []
        },
        {
          path: "assets/logo.bin",
          changeKind: "binary",
          source: "git",
          binary: true,
          summary: "Binary file metadata only.",
          evidence: []
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
          evidence: []
        }
      ],
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
      diffFiles: [
        {
          path: "package.json",
          changeKind: "modified",
          source: "git",
          binary: false,
          summary: "Changed package metadata.",
          evidence: []
        }
      ],
      evidence: []
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
        evidence: []
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
        evidence: []
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
        evidence: [],
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
        evidence: [],
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
        evidence: [],
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
        evidence: [],
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
        evidence: [],
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
