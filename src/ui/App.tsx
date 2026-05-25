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
import type { FormEvent as ReactFormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ApprovalDecision, ApprovalRequestId, CheckRunId, EventId, EvidenceRef, ProviderAvailability } from "../core";
import type {
  ApprovalCardViewModel,
  AgentRunCardViewModel,
  DashboardAction,
  CheckRunViewModel,
  DashboardProjection,
  ProjectCardViewModel,
  ProjectWorkspaceViewModel,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "../dashboard/types";
import type { ObservabilityDiagnostics } from "../observability/ObservabilityService";
import { defaultAppSettings, type AppSettings } from "../settings/SettingsService";
import { callApi, decideApprovalThroughApi, subscribeDashboard, type ApiStatus } from "./apiClient";
import "./styles.css";

type Route = "Home" | "Projects" | "Decisions" | "Artifacts" | "Activity" | "Settings";
type DetailFocusTarget = "project" | "evidence" | "diff";
type DetailFocusRequest = { target: DetailFocusTarget; nonce: number };
type PendingActionRequest = {
  method: string;
  label: string;
  projectId?: string;
  workItemId?: string;
  agentRunId?: string;
  checkId?: string;
  runId?: string;
  providerId?: string;
};

export function App() {
  const [route, setRoute] = useState<Route>("Home");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("project-alpha");
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<string[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingActionRequest | undefined>();
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
    if (dashboard.focusedProjectId && dashboard.focusedProjectId !== selectedProjectId) {
      setSelectedProjectId(dashboard.focusedProjectId);
    }
  }, [dashboard.focusedProjectId, selectedProjectId]);

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
    if (apiStatus === "live" && approval) {
      await decideApprovalThroughApi({ providerId: approval.providerId, approvalId, decision }).catch(() => undefined);
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

  function focusProject(projectId: string) {
    setSelectedProjectId(projectId);
    setRoute("Projects");
    if (apiStatus !== "live") return;
    void callApi<DashboardProjection>("dashboard.focusProject", { projectId })
      .then((snapshot) => setLiveDashboard(snapshot))
      .catch(() => undefined);
  }

  async function runPendingAction(action: PendingActionRequest, values: ActionFormValues) {
    if (apiStatus !== "live") {
      throw new Error("Connect the local runtime before executing this action.");
    }
    await callApi<unknown>(action.method, actionParams(action, values));
    const snapshot = await callApi<DashboardProjection>("dashboard.getSnapshot").catch(() => undefined);
    if (snapshot) {
      setLiveDashboard(snapshot);
      if (snapshot.focusedProjectId) setSelectedProjectId(snapshot.focusedProjectId);
    }
  }

  function openActionRequest(action: PendingActionRequest) {
    setPendingAction(action);
  }

  function handleProjectAction(project: ProjectCardViewModel, action: DashboardAction) {
    if (action.disabled) return;
    setSelectedProjectId(project.projectId);
    if (action.method === "projects.getWorkspace") {
      setRoute("Projects");
      return;
    }
    if (action.id === "open-approvals") {
      setRoute("Decisions");
      return;
    }
    if (action.id === "run-checks" || action.id === "rerun-checks") {
      setRoute("Projects");
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
        {route === "Home" && (
          <HomeView
            dashboard={dashboard}
            selectedProjectId={selectedProjectId}
            onRoute={setRoute}
            onSelectProject={focusProject}
            onDecision={decideApproval}
            onAction={openActionRequest}
          />
        )}
        {route === "Projects" && (
          <ProjectsRoute
            dashboard={dashboard}
            selectedProjectId={selectedProjectId}
            onRoute={setRoute}
            onSelectProject={focusProject}
            onProjectAction={handleProjectAction}
            onDecision={decideApproval}
            onAction={openActionRequest}
          />
        )}
        {route === "Decisions" && <ApprovalPanel approvals={dashboard.approvals} onDecision={decideApproval} onRoute={setRoute} />}
        {route === "Artifacts" && <ArtifactHub dashboard={dashboard} />}
        {route === "Activity" && <ActivityTimeline items={dashboard.timeline} />}
        {route === "Settings" && <SettingsPanel apiStatus={apiStatus} providers={dashboard.providerStatus} onRoute={setRoute} />}
      </section>
      <DetailPanel dashboard={dashboard} selectedProject={selectedProject} focusRequest={detailFocusRequest} />
      {commandPaletteOpen ? (
        <CommandPalette
          dashboard={dashboard}
          selectedProjectId={selectedProjectId}
          onClose={() => setCommandPaletteOpen(false)}
          onAction={openActionRequest}
          onRoute={(nextRoute) => {
            setRoute(nextRoute);
            setCommandPaletteOpen(false);
          }}
        />
      ) : null}
      {pendingAction ? (
        <ActionRequestDialog
          action={pendingAction}
          selectedProjectId={selectedProjectId}
          dashboard={dashboard}
          onClose={() => setPendingAction(undefined)}
          onRun={runPendingAction}
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
    { label: "Home", icon: LayoutDashboard },
    { label: "Projects", icon: GitBranch, badge: dashboard.projectCards.length },
    { label: "Decisions", icon: ShieldCheck, badge: dashboard.globalStatus.pendingApprovalCount },
    { label: "Artifacts", icon: ClipboardCheck, badge: dashboard.home.recentArtifacts.length },
    { label: "Activity", icon: Activity, badge: dashboard.globalStatus.activeTurnCount },
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
        <p className="modeQuestion">{modeQuestion(dashboard.mode)}</p>
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

function HomeView({
  dashboard,
  selectedProjectId,
  onRoute,
  onSelectProject,
  onDecision,
  onAction
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onRoute(route: Route): void;
  onSelectProject(projectId: string): void;
  onDecision(approvalId: string, decision: ApprovalDecision): void;
  onAction(action: PendingActionRequest): void;
}) {
  return (
    <div className="workspaceCockpit" aria-label="Home">
      <section className="cockpitBand" aria-label="Work inbox">
        <div className="sectionHeader">
          <ClipboardCheck size={22} aria-hidden="true" />
          <div>
            <h2>Work Inbox</h2>
            <p>Decisions, blocked work, running agents, new artifacts, and the next project to open.</p>
          </div>
        </div>
        <div className="inboxGrid">
          {dashboard.home.workInbox.length > 0 ? (
            dashboard.home.workInbox.map((item) => (
              <article key={item.id} className="workspaceMiniCard">
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                <button type="button" data-method={item.action.method} onClick={() => item.projectId && onSelectProject(item.projectId)}>
                  {item.action.label}
                </button>
              </article>
            ))
          ) : (
            <p className="emptyText">No immediate project work needs attention.</p>
          )}
        </div>
      </section>

      <section className="cockpitBand" aria-label="Waiting Decisions">
        <h2>Waiting Decisions</h2>
        <ApprovalPanel approvals={dashboard.home.waitingDecisions} onDecision={onDecision} onRoute={onRoute} />
      </section>

      <section className="cockpitBand" aria-label="Active Projects">
        <div className="sectionHeader">
          <GitBranch size={22} aria-hidden="true" />
          <div>
            <h2>Active Projects</h2>
            <p>Open the workspace that needs the next decision, review, or agent action.</p>
          </div>
        </div>
        <ProjectGrid
          dashboard={dashboard}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onProjectAction={(project) => onSelectProject(project.projectId)}
          onAction={onAction}
          onRoute={onRoute}
          compact
        />
      </section>

      <div className="workspaceColumns">
        <section className="cockpitBand" aria-label="Running Agents">
          <h2>Running Agents</h2>
          <AgentRunList runs={dashboard.home.runningAgents} onAction={onAction} />
        </section>
      </div>

      <div className="workspaceColumns">
        <HomeList title="Blocked Work" items={dashboard.home.blockedWork} onSelectProject={onSelectProject} />
        <section className="cockpitBand" aria-label="Ready to Review">
          <h2>Ready to Review</h2>
          {dashboard.home.readyToReview.map((project) => (
            <button key={project.projectId} type="button" className="workspaceListButton" onClick={() => onSelectProject(project.projectId)}>
              <strong>{project.title}</strong>
              <span>{project.reviewCheckStatus ?? project.stateLabel}</span>
            </button>
          ))}
          {dashboard.home.readyToReview.length === 0 ? <p className="emptyText">No projects are ready for review.</p> : null}
        </section>
      </div>

      <section className="cockpitBand" aria-label="Recent Artifacts">
        <h2>Recent Artifacts</h2>
        <ArtifactList artifacts={dashboard.home.recentArtifacts} />
      </section>

      <section className="cockpitBand" aria-label="Universal composer">
        <h2>Universal composer</h2>
        <div className="actionRow">
          {dashboard.home.quickCreate.map((action) => (
            <button
              key={action.id}
              type="button"
              data-method={action.method}
              onClick={() =>
                action.id === "open-decisions"
                  ? onRoute("Decisions")
                  : onAction({ method: action.method, label: action.label, projectId: selectedProjectId })
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function HomeList({ title, items, onSelectProject }: { title: string; items: DashboardProjection["home"]["blockedWork"]; onSelectProject(projectId: string): void }) {
  return (
    <section className="cockpitBand" aria-label={title}>
      <h2>{title}</h2>
      {items.map((item) => (
        <button key={item.id} type="button" className="workspaceListButton" onClick={() => item.projectId && onSelectProject(item.projectId)}>
          <strong>{item.title}</strong>
          <span>{item.summary}</span>
        </button>
      ))}
      {items.length === 0 ? <p className="emptyText">Nothing blocked.</p> : null}
    </section>
  );
}

function ProjectsRoute({
  dashboard,
  selectedProjectId,
  onRoute,
  onSelectProject,
  onProjectAction,
  onDecision,
  onAction
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onRoute(route: Route): void;
  onSelectProject(projectId: string): void;
  onProjectAction(project: ProjectCardViewModel, action: DashboardAction): void;
  onDecision(approvalId: string, decision: ApprovalDecision): void;
  onAction(action: PendingActionRequest): void;
}) {
  const workspace = dashboard.selectedWorkspace?.projectId === selectedProjectId ? dashboard.selectedWorkspace : undefined;
  if (workspace) {
    return (
      <ProjectWorkspace
        workspace={workspace}
        checkRuns={dashboard.checkRuns.filter((run) => run.projectId === workspace.projectId)}
        onDecision={onDecision}
        onRoute={onRoute}
        onAction={onAction}
      />
    );
  }
  return (
    <ProjectGrid
      dashboard={dashboard}
      selectedProjectId={selectedProjectId}
      onSelectProject={onSelectProject}
      onProjectAction={onProjectAction}
      onAction={onAction}
      onRoute={onRoute}
    />
  );
}

function ProjectWorkspace({
  workspace,
  checkRuns,
  onDecision,
  onRoute,
  onAction
}: {
  workspace: ProjectWorkspaceViewModel;
  checkRuns: CheckRunViewModel[];
  onDecision(approvalId: string, decision: ApprovalDecision): void;
  onRoute(route: Route): void;
  onAction(action: PendingActionRequest): void;
}) {
  const firstWorkItem = workspace.workItems.current[0] ?? workspace.workItems.queued[0] ?? workspace.workItems.blocked[0] ?? workspace.workItems.completed[0];
  return (
    <div className="projectWorkspace" role="region" aria-label="Project Workspace">
      <section className="workspaceHeader" aria-label="Project Header">
        <div>
          <p className="eyebrow">Project workspace</p>
          <h2>{workspace.header.name}</h2>
          <div className="facetRow">
            {workspace.header.profileFacets.map((facet) => (
              <span key={facet} className="stateBadge unknown">{facet.replaceAll("_", " ")}</span>
            ))}
          </div>
        </div>
        <dl className="metricGrid">
          <div><dt>State</dt><dd>{workspace.header.state.replaceAll("_", " ")}</dd></div>
          <div><dt>Active work</dt><dd>{workspace.header.activeWorkCount}</dd></div>
          <div><dt>Running agents</dt><dd>{workspace.header.runningAgentCount}</dd></div>
          <div><dt>Decisions</dt><dd>{workspace.header.pendingDecisionCount}</dd></div>
          <div><dt>Latest artifact</dt><dd>{workspace.header.latestArtifact?.title ?? "None"}</dd></div>
        </dl>
        <button
          type="button"
          data-method={workspace.header.primaryAction.method}
          onClick={() => onAction({ method: workspace.header.primaryAction.method, label: workspace.header.primaryAction.label, projectId: workspace.projectId })}
        >
          {workspace.header.primaryAction.label}
        </button>
      </section>

      <div className="workspaceColumns">
        <section className="cockpitBand" aria-label="Work Items panel">
          <h2>Work Items</h2>
          <WorkItemColumn title="Current work" items={workspace.workItems.current} />
          <WorkItemColumn title="Queued work" items={workspace.workItems.queued} />
          <WorkItemColumn title="Blocked work" items={workspace.workItems.blocked} />
          <WorkItemColumn title="Completed work" items={workspace.workItems.completed} />
          <div className="actionRow">
            <button type="button" data-method="workItems.create" onClick={() => onAction({ method: "workItems.create", label: "Create work item", projectId: workspace.projectId })}>Create work item</button>
            <button type="button" data-method="projects.addSource" onClick={() => onAction({ method: "projects.addSource", label: "Attach sources", projectId: workspace.projectId })}>Attach sources</button>
            <button
              type="button"
              data-method="agentRuns.create"
              onClick={() => onAction({ method: "agentRuns.create", label: "Assign agents", projectId: workspace.projectId, workItemId: firstWorkItem?.id })}
            >
              Assign agents
            </button>
          </div>
        </section>

        <section className="cockpitBand" aria-label="Agent Board">
          <h2>Agent Board</h2>
          <div className="agentBoard">
            {(["queued", "running", "waiting", "blocked", "review", "done"] as const).map((column) => (
              <section key={column} aria-label={`${column} agents`}>
                <h3>{column}</h3>
                <AgentRunList runs={workspace.agentBoard[column]} onAction={onAction} />
              </section>
            ))}
          </div>
        </section>
      </div>

      <div className="workspaceColumns">
        <section className="cockpitBand" aria-label="Sources panel">
          <h2>Sources</h2>
          {workspace.sources.map((source) => (
            <article key={source.id} className="workspaceMiniCard">
              <h3>{source.title}</h3>
              <p>{source.type.replaceAll("_", " ")}{source.uriOrPath ? ` · ${source.uriOrPath}` : ""}</p>
              <small>{source.usedByWorkItemIds.length} work item(s)</small>
            </article>
          ))}
        </section>
        <section className="cockpitBand" aria-label="Artifacts panel">
          <h2>Artifacts</h2>
          <ArtifactList artifacts={workspace.artifacts} />
        </section>
      </div>

      <div className="workspaceColumns">
        <section className="cockpitBand" aria-label="Decisions panel">
          <h2>Decisions</h2>
          <ApprovalPanel approvals={workspace.decisions} onDecision={onDecision} onRoute={onRoute} />
        </section>
        <section className="cockpitBand" aria-label="Checks inside project workspace">
          <h2>Checks</h2>
          <CheckRunPanel checkRuns={checkRuns} onAction={onAction} />
        </section>
      </div>

      <section className="cockpitBand" aria-label="Project Timeline">
        <h2>Project Timeline</h2>
        <ActivityTimeline items={workspace.timeline} />
      </section>
    </div>
  );
}

function WorkItemColumn({ title, items }: { title: string; items: ProjectWorkspaceViewModel["workItems"]["current"] }) {
  return (
    <section className="workItemColumn" aria-label={title}>
      <h3>{title}</h3>
      {items.map((item) => (
        <article key={item.id} className="workspaceMiniCard">
          <h4>{item.title}</h4>
          <p>{item.goal}</p>
          <small>{item.status} · {item.workModes.join(", ")}</small>
        </article>
      ))}
      {items.length === 0 ? <p className="emptyText">None.</p> : null}
    </section>
  );
}

function AgentRunList({ runs, onAction }: { runs: AgentRunCardViewModel[]; onAction(action: PendingActionRequest): void }) {
  if (runs.length === 0) return <p className="emptyText">No agent runs.</p>;
  return (
    <div className="agentRunList">
      {runs.map((run) => (
        <article key={run.runId} className={`workspaceMiniCard status-${run.status}`}>
          <h4>{run.roleName}</h4>
          <p>{run.providerLabel} · {run.linkedWorkItemTitle}</p>
          <dl className="approvalMeta">
            <div><dt>Status</dt><dd>{run.status.replaceAll("_", " ")}</dd></div>
            <div><dt>Decisions</dt><dd>{run.pendingDecisionCount}</dd></div>
            <div><dt>Artifacts</dt><dd>{run.producedArtifactCount}</dd></div>
          </dl>
          <button
            type="button"
            data-method={run.primaryAction.method}
            onClick={() =>
              onAction({
                method: run.primaryAction.method,
                label: run.primaryAction.label,
                projectId: run.projectId,
                workItemId: run.workItemId,
                agentRunId: run.runId,
                providerId: run.providerId
              })
            }
          >
            {run.primaryAction.label}
          </button>
          <details>
            <summary>Advanced session details</summary>
            <p>{run.advanced.sessionId ?? "No provider session linked"}</p>
            <p>{run.advanced.providerSessionExternalKind ?? "Provider reference hidden"}</p>
          </details>
        </article>
      ))}
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: DashboardProjection["home"]["recentArtifacts"] }) {
  if (artifacts.length === 0) return <p className="emptyText">No artifacts yet.</p>;
  return (
    <div className="artifactGrid">
      {artifacts.map((artifact) => (
        <article key={artifact.id} className={`workspaceMiniCard artifact-${artifact.status}`}>
          <span className="stateBadge review">{artifact.type.replaceAll("_", " ")}</span>
          <h3>{artifact.title}</h3>
          <p>{artifact.summary || artifact.status}</p>
          <small>{artifact.sourceIds.length} source(s) · {artifact.evidence.length} evidence reference(s)</small>
        </article>
      ))}
    </div>
  );
}

function ArtifactHub({ dashboard }: { dashboard: DashboardProjection }) {
  const artifacts = Object.values(dashboard.selectedWorkspace ? { selected: dashboard.selectedWorkspace.artifacts } : {})
    .flat()
    .concat(dashboard.home.recentArtifacts)
    .filter((artifact, index, items) => items.findIndex((candidate) => candidate.id === artifact.id) === index);
  return (
    <section className="cockpitBand" aria-label="Artifacts">
      <div className="sectionHeader">
        <ClipboardCheck size={22} aria-hidden="true" />
        <div>
          <h2>Artifacts</h2>
          <p>Drafts, reports, plans, code patches, diagrams, logs, review findings, and custom outputs across projects.</p>
        </div>
      </div>
      <ArtifactList artifacts={artifacts} />
    </section>
  );
}

function ProjectGrid({
  dashboard,
  selectedProjectId,
  onSelectProject,
  onProjectAction,
  onAction,
  onRoute,
  compact = false
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onProjectAction(project: ProjectCardViewModel, action: DashboardAction): void;
  onAction(action: PendingActionRequest): void;
  onRoute(route: Route): void;
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
        <div className="actionRow">
          <button type="button" data-method="projects.register" onClick={() => onAction({ method: "projects.register", label: "Register project" })}>
            Register project
          </button>
          <button type="button" data-method="providers.getStatus" onClick={() => onRoute("Settings")}>
            Provider setup
          </button>
        </div>
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
  const disabledActions = [project.primaryAction, ...project.secondaryActions].filter(
    (action) => action.disabled && action.disabledReason
  );

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
          <small>{project.profileFacets.slice(0, 3).map((facet) => facet.replaceAll("_", " ")).join(" · ")}</small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      <div className="facetRow">
        {project.profileFacets.slice(0, 5).map((facet) => (
          <span key={`${project.projectId}-${facet}`} className="stateBadge unknown">
            {facet.replaceAll("_", " ")}
          </span>
        ))}
      </div>
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
          <dt>Current work</dt>
          <dd>{project.currentWorkItemTitle ?? "None"}</dd>
        </div>
        <div>
          <dt>Active agents</dt>
          <dd>{project.activeAgentCount}</dd>
        </div>
        <div>
          <dt>Waiting agents</dt>
          <dd>{project.waitingAgentCount}</dd>
        </div>
        <div>
          <dt>Blocked agents</dt>
          <dd>{project.blockedAgentCount}</dd>
        </div>
        <div>
          <dt>Decisions</dt>
          <dd>{project.pendingApprovalCount}</dd>
        </div>
        <div>
          <dt>Latest artifact</dt>
          <dd>{project.latestArtifactTitle ?? "None"}</dd>
        </div>
        <div>
          <dt>Review/checks</dt>
          <dd>{project.reviewCheckStatus ?? `${project.failedCheckCount} failed`}</dd>
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
      {disabledActions.length > 0 ? (
        <ul className="disabledReasons" aria-label="Unavailable actions">
          {disabledActions.map((action) => (
            <li key={action.id}>
              <span>{action.label}</span>
              <span>{action.disabledReason}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
  onDecision,
  onRoute
}: {
  approvals: ApprovalCardViewModel[];
  onDecision(approvalId: string, decision: ApprovalDecision): void;
  onRoute?(route: Route): void;
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
        <button
          type="button"
          data-method="events.query"
          onClick={() => (onRoute ? onRoute("Activity") : document.querySelector<HTMLElement>('[aria-label="Activity timeline"]')?.focus())}
        >
          Recent decisions
        </button>
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

function ProviderGrid({
  providers,
  onConfigureProvider,
  onCheckAvailability
}: {
  providers: ProviderStatusViewModel[];
  onConfigureProvider(providerId: string): void;
  onCheckAvailability(providerId: string): void;
}) {
  if (providers.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Provider status">
        <SlidersHorizontal size={26} aria-hidden="true" />
        <h2>No providers configured</h2>
        <p>The fake provider remains available for development and test workflows without requiring a real runtime provider.</p>
        <button type="button" data-method="providers.list" onClick={() => onConfigureProvider("new-provider")}>
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
            <button type="button" data-method="providers.checkAvailability" onClick={() => onCheckAvailability(provider.providerId)}>
              Check availability
            </button>
            <button type="button" data-method="providers.getStatus" onClick={() => onConfigureProvider(provider.providerId)}>
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

function ProviderConfigurationPanel({
  provider,
  selectedProviderId,
  checkMessage,
  settings,
  providers,
  onCheckAvailability,
  onUpdateSettings
}: {
  provider?: ProviderStatusViewModel;
  selectedProviderId?: string;
  checkMessage?: string;
  settings: AppSettings;
  providers: ProviderStatusViewModel[];
  onCheckAvailability(providerId: string): void;
  onUpdateSettings(patch: Partial<AppSettings>): void;
}) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selectedProviderId) return;
    panelRef.current?.focus();
  }, [selectedProviderId]);

  if (!selectedProviderId) {
    return <p className="emptyText">Select Configure provider to review setup, availability, and activation details.</p>;
  }

  if (!provider) {
    return (
      <section ref={panelRef} className="providerConfigPanel" aria-label="Provider configuration" tabIndex={-1}>
        <h4>Provider configuration</h4>
        <p>No provider is selected. Start the local runtime to inspect registered providers.</p>
      </section>
    );
  }

  const configuredProvider = provider;
  const command = providerAvailabilityCommand(configuredProvider.availability);
  const providerEnabled = providerEnabledForNextStartup(settings, providers, configuredProvider.providerId);
  const providerIsDefault = settings.defaultProviderId === configuredProvider.providerId;
  const nextStep = providerNextStep(configuredProvider, providerEnabled, providerIsDefault);

  function toggleProviderEnabled() {
    const nextEnabledProviderIds = nextEnabledProviderIdsForToggle(settings, providers, configuredProvider.providerId);
    const patch: Partial<AppSettings> = { enabledProviderIds: nextEnabledProviderIds as AppSettings["enabledProviderIds"] };
    if (settings.defaultProviderId === configuredProvider.providerId && providerEnabled) {
      patch.defaultProviderId = undefined;
    }
    onUpdateSettings(patch);
  }

  function setDefaultProvider() {
    const nextEnabledProviderIds = providerEnabled
      ? settings.enabledProviderIds
      : nextEnabledProviderIdsForToggle(settings, providers, configuredProvider.providerId);
    onUpdateSettings({
      defaultProviderId: configuredProvider.providerId,
      enabledProviderIds: nextEnabledProviderIds as AppSettings["enabledProviderIds"]
    });
  }

  return (
    <section ref={panelRef} className="providerConfigPanel" aria-label="Provider configuration" tabIndex={-1}>
      <div className="settingsHeaderRow">
        <div>
          <h4>{configuredProvider.name} configuration</h4>
          <p>
            This provider is registered for runtime use but is only used by projects or agent runs that explicitly choose it.
          </p>
        </div>
        <span className={`stateBadge ${configuredProvider.availability.status === "available" ? "passed" : "failed"}`}>
          {configuredProvider.availability.status}
        </span>
      </div>
      <dl className="settingsGrid">
        <div>
          <dt>Provider id</dt>
          <dd>{configuredProvider.providerId}</dd>
        </div>
        <div>
          <dt>Adapter</dt>
          <dd>{configuredProvider.adapterVersion}</dd>
        </div>
        <div>
          <dt>Command</dt>
          <dd>{command ?? "not reported"}</dd>
        </div>
        <div>
          <dt>Startup</dt>
          <dd>{providerEnabled ? "enabled" : "disabled"}</dd>
        </div>
        <div>
          <dt>Default</dt>
          <dd>{providerIsDefault ? "yes" : "no"}</dd>
        </div>
      </dl>
      <p>{nextStep}</p>
      {checkMessage ? <p>{checkMessage}</p> : null}
      {providerAvailabilityReason(configuredProvider.availability) ? <p>{providerAvailabilityReason(configuredProvider.availability)}</p> : null}
      <ul className="settingsList" aria-label="Provider setup">
        <li>Registered providers are available to projects and agent runs that explicitly choose them.</li>
        <li>Set any provider binary or environment overrides before startup.</li>
        <li>Restart the local runtime after changing provider environment or command configuration.</li>
      </ul>
      <div className="actionRow">
        <button type="button" data-method="providers.checkAvailability" onClick={() => onCheckAvailability(configuredProvider.providerId)}>
          Check availability
        </button>
        <button type="button" data-method="settings.update" onClick={toggleProviderEnabled}>
          {providerEnabled ? "Disable on next startup" : "Enable on next startup"}
        </button>
        {providerIsDefault ? (
          <button type="button" data-method="settings.update" onClick={() => onUpdateSettings({ defaultProviderId: undefined })}>
            Clear default provider
          </button>
        ) : (
          <button type="button" data-method="settings.update" onClick={setDefaultProvider} disabled={!providerEnabled && providers.length === 0}>
            Set as default provider
          </button>
        )}
      </div>
    </section>
  );
}

function providerAvailabilityCommand(availability: ProviderAvailability): string | undefined {
  const details = availability.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const command = (details as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function providerAvailabilityReason(availability: ProviderAvailability): string | undefined {
  return "reason" in availability ? availability.reason : undefined;
}

function providerEnabledForNextStartup(
  settings: AppSettings,
  providers: ProviderStatusViewModel[],
  providerIdValue: string
): boolean {
  if (settings.enabledProviderIds.length === 0) {
    return providers.some((provider) => provider.providerId === providerIdValue);
  }
  return settings.enabledProviderIds.includes(providerIdValue as AppSettings["enabledProviderIds"][number]);
}

function nextEnabledProviderIdsForToggle(
  settings: AppSettings,
  providers: ProviderStatusViewModel[],
  providerIdValue: string
): string[] {
  const current =
    settings.enabledProviderIds.length === 0
      ? providers.map((provider) => provider.providerId)
      : settings.enabledProviderIds.map((providerIdValueCurrent) => String(providerIdValueCurrent));
  return current.includes(providerIdValue)
    ? current.filter((candidate) => candidate !== providerIdValue)
    : [...current, providerIdValue];
}

function providerNextStep(provider: ProviderStatusViewModel, enabled: boolean, isDefault: boolean): string {
  if (!enabled) {
    return "Next: enable this provider for the next runtime startup, then restart the local runtime.";
  }
  if (provider.availability.status !== "available") {
    return "Next: fix the provider command or environment, restart the local runtime, then run Check availability.";
  }
  if (!isDefault) {
    return "Next: set this provider as a default or assign it to a specific project agent run.";
  }
  return "Next: create or open a project work item and start an agent run with this provider.";
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
  selectedProjectId,
  onClose,
  onAction,
  onRoute
}: {
  dashboard: DashboardProjection;
  selectedProjectId: string;
  onClose(): void;
  onAction(action: PendingActionRequest): void;
  onRoute(route: Route): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const commands: CommandItem[] = [
    { id: "create-project", label: "Create project", method: "projects.register", route: "Projects" },
    { id: "add-source", label: "Add source", method: "projects.addSource", route: "Projects" },
    { id: "create-work-item", label: "Create work item", method: "workItems.create", route: "Projects" },
    {
      id: "start-agent-run",
      label: "Start agent run",
      method: "agentRuns.start",
      route: "Projects",
      disabled: dashboard.providerStatus.every((provider) => !provider.capabilities.canStartSession)
    },
    { id: "ask-in-project", label: "Ask within selected project", method: "agentRuns.sendInstruction", route: "Projects" },
    { id: "create-artifact", label: "Create artifact", method: "artifacts.create", route: "Artifacts" },
    { id: "open-decisions", label: "Open decision center", method: "agents.respondToApproval", route: "Decisions" },
    { id: "run-checks", label: "Run checks", method: "checks.run", route: "Projects" },
    { id: "open-diff-review", label: "Open diff review", method: "git.openDiff", route: "Projects" },
    { id: "show-provider-status", label: "Show provider status", method: "providers.getStatus", route: "Settings" },
    { id: "open-event-log", label: "Open event log", method: "events.query", route: "Activity" }
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = commands.filter(
    (command) =>
      normalizedQuery.length === 0 ||
      command.label.toLowerCase().includes(normalizedQuery) ||
      command.method.toLowerCase().includes(normalizedQuery)
  );

  function runCommand(command: CommandItem) {
    if (command.disabled) return;
    if (commandOpensAction(command)) {
      onAction({
        method: command.method,
        label: command.label,
        projectId: command.id === "create-project" ? undefined : selectedProjectId
      });
      onClose();
      return;
    }
    onRoute(command.route);
  }

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
              onClick={() => runCommand(command)}
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

function commandOpensAction(command: CommandItem): boolean {
  return [
    "create-project",
    "add-source",
    "create-work-item",
    "start-agent-run",
    "ask-in-project",
    "create-artifact",
    "run-checks"
  ].includes(command.id);
}

type ActionFormValues = {
  projectId: string;
  rootPath: string;
  name: string;
  title: string;
  goal: string;
  summary: string;
  type: string;
  uriOrPath: string;
  workModes: string;
  workItemId: string;
  agentRunId: string;
  providerId: string;
  roleName: string;
  instruction: string;
  checkId: string;
  runId: string;
  reason: string;
};

type FormOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

function defaultProviderIdForAction(action: PendingActionRequest, providers: ProviderStatusViewModel[]): string {
  if (action.providerId) return action.providerId;
  const preferredProvider = action.method === "agentRuns.create" ? providers.find((provider) => provider.capabilities.canStartSession) : undefined;
  return preferredProvider?.providerId ?? providers[0]?.providerId ?? "";
}

function ActionRequestDialog({
  action,
  selectedProjectId,
  dashboard,
  onClose,
  onRun
}: {
  action: PendingActionRequest;
  selectedProjectId: string;
  dashboard: DashboardProjection;
  onClose(): void;
  onRun(action: PendingActionRequest, values: ActionFormValues): Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const providers = dashboard.providerStatus;
  const [values, setValues] = useState<ActionFormValues>({
    projectId: action.projectId ?? selectedProjectId,
    rootPath: "",
    name: "",
    title: defaultActionTitle(action),
    goal: "",
    summary: "",
    type: defaultActionType(action),
    uriOrPath: "",
    workModes: "custom",
    workItemId: action.workItemId ?? "",
    agentRunId: action.agentRunId ?? "",
    providerId: defaultProviderIdForAction(action, providers),
    roleName: "Worker",
    instruction: "",
    checkId: action.checkId ?? "",
    runId: action.runId ?? "",
    reason: ""
  });
  const [status, setStatus] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const projectOptions = useMemo<FormOption[]>(
    () =>
      dashboard.projectCards.map((project) => ({
        value: project.projectId,
        label: project.title,
        detail: project.stateLabel
      })),
    [dashboard.projectCards]
  );
  const selectedWorkspace = useMemo(
    () => (dashboard.selectedWorkspace?.projectId === values.projectId ? dashboard.selectedWorkspace : undefined),
    [dashboard.selectedWorkspace, values.projectId]
  );
  const workItemOptions = useMemo<FormOption[]>(
    () =>
      selectedWorkspace
        ? [
            ...selectedWorkspace.workItems.current,
            ...selectedWorkspace.workItems.queued,
            ...selectedWorkspace.workItems.blocked,
            ...selectedWorkspace.workItems.completed
          ].map((workItem) => ({
            value: workItem.id,
            label: workItem.title,
            detail: workItem.status.replaceAll("_", " ")
          }))
        : [],
    [selectedWorkspace]
  );
  const agentRunOptions = useMemo<FormOption[]>(() => {
    const workspaceRuns = selectedWorkspace
      ? (["queued", "running", "waiting", "blocked", "review", "done"] as const).flatMap((column) => selectedWorkspace.agentBoard[column])
      : [];
    const homeRuns = dashboard.home.runningAgents.filter((run) => run.projectId === values.projectId);
    return uniqueOptions(
      [...workspaceRuns, ...homeRuns].map((run) => ({
        value: run.runId,
        label: run.roleName,
        detail: `${run.status.replaceAll("_", " ")} · ${run.linkedWorkItemTitle}`
      }))
    );
  }, [dashboard.home.runningAgents, selectedWorkspace, values.projectId]);
  const providerOptions = useMemo<FormOption[]>(
    () =>
      providers.map((provider) => ({
        value: provider.providerId,
        label: provider.name,
        detail: provider.availability.status,
        disabled: action.method === "agentRuns.create" && !provider.capabilities.canStartSession
      })),
    [action.method, providers]
  );
  const checkOptions = useMemo<FormOption[]>(
    () =>
      dashboard.checkRuns
        .filter((run) => !values.projectId || run.projectId === values.projectId)
        .map((run) => ({
          value: run.checkId,
          label: run.name,
          detail: `${run.status} · ${run.projectTitle}`
        })),
    [dashboard.checkRuns, values.projectId]
  );
  const checkRunOptions = useMemo<FormOption[]>(
    () =>
      dashboard.checkRuns
        .filter((run) => !values.projectId || run.projectId === values.projectId)
        .map((run) => ({
          value: run.runId,
          label: run.name,
          detail: `${run.status} · ${run.projectTitle}`
        })),
    [dashboard.checkRuns, values.projectId]
  );

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input, select, textarea")?.focus();
  }, []);

  useEffect(() => {
    setValues((current) => {
      const next = { ...current };
      let changed = false;
      function setDefault(field: keyof ActionFormValues, options: FormOption[]) {
        if (next[field] || options.length === 0) return;
        next[field] = options.find((option) => !option.disabled)?.value ?? options[0]?.value ?? "";
        changed = true;
      }
      if (actionNeedsProject(action.method)) setDefault("projectId", projectOptions);
      if (action.method === "agentRuns.create") setDefault("workItemId", workItemOptions);
      if (action.method === "agentRuns.create") setDefault("providerId", providerOptions);
      if (action.method === "agentRuns.start" || action.method === "agentRuns.sendInstruction" || action.method === "agentRuns.cancel") {
        setDefault("agentRunId", agentRunOptions);
      }
      if (action.method === "checks.run" || action.method === "checks.waive") setDefault("checkId", checkOptions);
      if (action.method === "checks.cancel") setDefault("runId", checkRunOptions);
      if (action.method === "providers.getStatus" || action.method === "providers.list") setDefault("providerId", providerOptions);
      return changed ? next : current;
    });
  }, [action.method, agentRunOptions, checkOptions, checkRunOptions, projectOptions, providerOptions, workItemOptions]);

  function updateField(field: keyof ActionFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function updateProject(value: string) {
    setValues((current) => ({
      ...current,
      projectId: value,
      workItemId: "",
      agentRunId: "",
      checkId: "",
      runId: ""
    }));
  }

  function renderChoiceField({
    label,
    field,
    options,
    required = true,
    fallbackLabel = `${label} id`,
    hint
  }: {
    label: string;
    field: keyof ActionFormValues;
    options: FormOption[];
    required?: boolean;
    fallbackLabel?: string;
    hint?: string;
  }) {
    if (options.length > 0) {
      return (
        <>
          <label>
            {label}
            <select
              value={values[field]}
              onChange={(event) => updateField(field, event.target.value)}
              required={required}
            >
              {values[field] ? null : <option value="">Select {label.toLowerCase()}</option>}
              {options.map((option) => (
                <option key={`${field}-${option.value}`} value={option.value} disabled={option.disabled}>
                  {option.detail ? `${option.label} (${option.detail})` : option.label}
                </option>
              ))}
            </select>
          </label>
          {hint ? <p className="fieldHint">{hint}</p> : null}
        </>
      );
    }
    return (
      <>
        <label>
          {fallbackLabel}
          <input value={values[field]} onChange={(event) => updateField(field, event.target.value)} required={required} />
        </label>
        <p className="fieldHint">{hint ?? `${label} choices are not loaded for this project. Open the project workspace or paste the id.`}</p>
      </>
    );
  }

  function renderProjectField() {
    if (projectOptions.length > 0) {
      return (
        <label>
          Project
          <select value={values.projectId} onChange={(event) => updateProject(event.target.value)} required>
            {values.projectId ? null : <option value="">Select project</option>}
            {projectOptions.map((project) => (
              <option key={project.value} value={project.value}>
                {project.detail ? `${project.label} (${project.detail})` : project.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    return (
      <>
        <label>
          Project id
          <input value={values.projectId} onChange={(event) => updateProject(event.target.value)} required />
        </label>
        <p className="fieldHint">Create or select a project workspace before starting project-scoped work.</p>
      </>
    );
  }

  async function submit(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunning(true);
    setStatus(undefined);
    try {
      await onRun(action, values);
      setStatus("Action completed.");
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="actionDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current, onClose)}
      >
        <div>
          <span className="stateBadge active">{action.method}</span>
          <h2 id="action-dialog-title">{action.label}</h2>
          <p>{actionGuidance(action.method)}</p>
        </div>
        <form className="actionForm" onSubmit={submit}>
          {actionNeedsProject(action.method) ? renderProjectField() : null}
          {action.method === "projects.register" ? (
            <>
              <label>
                Root path
                <input
                  value={values.rootPath}
                  onChange={(event) => updateField("rootPath", event.target.value)}
                  placeholder="/path/to/project-workspace"
                  required
                />
              </label>
              <label>
                Project name
                <input value={values.name} onChange={(event) => updateField("name", event.target.value)} />
              </label>
            </>
          ) : null}
          {action.method === "projects.addSource" ? (
            <>
              <label>
                Source title
                <input value={values.title} onChange={(event) => updateField("title", event.target.value)} required />
              </label>
              <label>
                Source type
                <input
                  value={values.type}
                  onChange={(event) => updateField("type", event.target.value)}
                  placeholder="note, url, repository, dataset, custom"
                  required
                />
              </label>
              <label>
                URI or path
                <input
                  value={values.uriOrPath}
                  onChange={(event) => updateField("uriOrPath", event.target.value)}
                  placeholder="Optional source location"
                />
              </label>
            </>
          ) : null}
          {action.method === "workItems.create" ? (
            <>
              <label>
                Work item title
                <input value={values.title} onChange={(event) => updateField("title", event.target.value)} required />
              </label>
              <label>
                Goal
                <textarea value={values.goal} onChange={(event) => updateField("goal", event.target.value)} required />
              </label>
              <label>
                Work modes
                <input value={values.workModes} onChange={(event) => updateField("workModes", event.target.value)} />
              </label>
            </>
          ) : null}
          {action.method === "agentRuns.create" ? (
            <>
              {renderChoiceField({
                label: "Work item",
                field: "workItemId",
                options: workItemOptions,
                hint: "Agent runs are always linked to a visible work item."
              })}
              {renderChoiceField({
                label: "Provider",
                field: "providerId",
                options: providerOptions,
                fallbackLabel: "Provider id",
                hint: "Unavailable providers are shown but cannot be selected for a new run."
              })}
              <label>
                Role name
                <input value={values.roleName} onChange={(event) => updateField("roleName", event.target.value)} required />
              </label>
              <label>
                Goal
                <textarea value={values.goal} onChange={(event) => updateField("goal", event.target.value)} required />
              </label>
            </>
          ) : null}
          {action.method === "agentRuns.start" || action.method === "agentRuns.sendInstruction" ? (
            <>
              {renderChoiceField({
                label: "Agent run",
                field: "agentRunId",
                options: agentRunOptions,
                hint: "Session and thread details stay hidden behind the agent run."
              })}
              <label>
                {action.method === "agentRuns.start" ? "First instruction" : "Instruction"}
                <textarea
                  value={values.instruction}
                  onChange={(event) => updateField("instruction", event.target.value)}
                  required={action.method === "agentRuns.sendInstruction"}
                />
              </label>
            </>
          ) : null}
          {action.method === "agentRuns.cancel"
            ? renderChoiceField({
                label: "Agent run",
                field: "agentRunId",
                options: agentRunOptions,
                hint: "Cancelling stops the selected project worker attempt, not the project."
              })
            : null}
          {action.method === "artifacts.create" ? (
            <>
              <label>
                Artifact title
                <input value={values.title} onChange={(event) => updateField("title", event.target.value)} required />
              </label>
              <label>
                Artifact type
                <input
                  value={values.type}
                  onChange={(event) => updateField("type", event.target.value)}
                  placeholder="report, plan, checklist, code_patch, custom"
                  required
                />
              </label>
              <label>
                Summary
                <textarea value={values.summary} onChange={(event) => updateField("summary", event.target.value)} />
              </label>
            </>
          ) : null}
          {action.method === "checks.run" || action.method === "checks.waive" ? (
            renderChoiceField({
              label: "Check",
              field: "checkId",
              options: checkOptions,
              hint: "Required failed checks block review readiness until they pass or are explicitly waived."
            })
          ) : null}
          {action.method === "checks.cancel" ? (
            renderChoiceField({
              label: "Check run",
              field: "runId",
              options: checkRunOptions,
              fallbackLabel: "Run id",
              hint: "Only active check runs can be cancelled by the runtime."
            })
          ) : null}
          {action.method === "checks.waive" ? (
            <label>
              Reason
              <textarea value={values.reason} onChange={(event) => updateField("reason", event.target.value)} />
            </label>
          ) : null}
          {action.method === "providers.getStatus" || action.method === "providers.list"
            ? renderChoiceField({
                label: "Provider",
                field: "providerId",
                options: providerOptions,
                required: false,
                fallbackLabel: "Provider id",
                hint: "Use Settings to check availability, choose a default, or change startup enablement."
              })
            : null}
          {status ? <p>{status}</p> : null}
          <div className="actionRow">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" data-method={action.method} disabled={running}>
              {running ? "Running" : "Run action"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function uniqueOptions(options: FormOption[]): FormOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function actionParams(action: PendingActionRequest, values: ActionFormValues): unknown {
  switch (action.method) {
    case "projects.register":
      return { rootPath: requireValue(values.rootPath, "Root path"), name: values.name || undefined };
    case "projects.addSource":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        type: requireValue(values.type, "Source type"),
        title: requireValue(values.title, "Source title"),
        uriOrPath: values.uriOrPath || undefined,
        addedBy: "user",
        metadata: {}
      };
    case "workItems.create":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        title: requireValue(values.title, "Work item title"),
        goal: requireValue(values.goal, "Goal"),
        workModes: values.workModes.split(",").map((item) => item.trim()).filter(Boolean),
        priority: 0,
        sourceIds: [],
        artifactIds: [],
        metadata: {}
      };
    case "agentRuns.create":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        workItemId: requireValue(values.workItemId, "Work item id"),
        providerId: requireValue(values.providerId, "Provider id"),
        roleName: requireValue(values.roleName, "Role name"),
        rolePreset: "custom",
        goal: requireValue(values.goal, "Goal"),
        metadata: {}
      };
    case "agentRuns.start":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        agentRunId: requireValue(values.agentRunId, "Agent run id"),
        instruction: values.instruction || undefined
      };
    case "agentRuns.sendInstruction":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        agentRunId: requireValue(values.agentRunId, "Agent run id"),
        instruction: requireValue(values.instruction, "Instruction")
      };
    case "agentRuns.cancel":
      return { projectId: requireValue(values.projectId, "Project id"), agentRunId: requireValue(values.agentRunId, "Agent run id") };
    case "artifacts.create":
      return {
        projectId: requireValue(values.projectId, "Project id"),
        type: requireValue(values.type, "Artifact type"),
        title: requireValue(values.title, "Artifact title"),
        summary: values.summary,
        status: "draft",
        sourceIds: [],
        evidence: [],
        metadata: {}
      };
    case "checks.list":
      return { projectId: requireValue(values.projectId, "Project id") };
    case "checks.run":
      return { projectId: requireValue(values.projectId, "Project id"), checkId: requireValue(values.checkId, "Check id") };
    case "checks.cancel":
      return { runId: requireValue(values.runId, "Run id") };
    case "checks.waive":
      return { projectId: requireValue(values.projectId, "Project id"), checkId: requireValue(values.checkId, "Check id"), reason: values.reason || undefined };
    case "providers.getStatus":
    case "providers.list":
      return values.providerId ? { providerId: values.providerId } : undefined;
    default:
      return {};
  }
}

function actionNeedsProject(method: string): boolean {
  return [
    "projects.addSource",
    "workItems.create",
    "agentRuns.create",
    "agentRuns.start",
    "agentRuns.sendInstruction",
    "agentRuns.cancel",
    "artifacts.create",
    "checks.list",
    "checks.run",
    "checks.waive"
  ].includes(method);
}

function defaultActionTitle(action: PendingActionRequest): string {
  if (action.method === "projects.addSource") return "New source";
  if (action.method === "workItems.create") return "New work item";
  if (action.method === "artifacts.create") return "New artifact";
  return "";
}

function defaultActionType(action: PendingActionRequest): string {
  if (action.method === "projects.addSource") return "note";
  if (action.method === "artifacts.create") return "generic_file";
  return "";
}

function actionGuidance(method: string): string {
  if (method === "projects.register") return "Register a durable project workspace from a local root path.";
  if (method === "projects.addSource") return "Attach a source to the selected project so work items can reference it.";
  if (method === "workItems.create") return "Create a visible unit of project work before assigning an agent run.";
  if (method === "agentRuns.create") return "Create an agent run linked to a work item and provider.";
  if (method === "agentRuns.start") return "Start the selected agent run and optionally include the first instruction.";
  if (method === "agentRuns.sendInstruction") return "Send a follow-up instruction to a running or waiting agent run.";
  if (method === "artifacts.create") return "Create a project artifact linked to the workspace.";
  if (method.startsWith("checks.")) return "Run, cancel, list, or waive project checks with explicit project/check context.";
  return "Review the required context, then run the action against the local runtime.";
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function CheckRunPanel({ checkRuns, onAction }: { checkRuns: CheckRunViewModel[]; onAction(action: PendingActionRequest): void }) {
  const activeRuns = checkRuns.filter((run) => run.status === "queued" || run.status === "running");
  const recentRuns = checkRuns.filter((run) => run.status !== "queued" && run.status !== "running");

  if (checkRuns.length === 0) {
    return (
      <section className="emptyPanel" aria-label="Check runs">
        <ListChecks size={26} aria-hidden="true" />
        <h2>No checks have run</h2>
        <p>Add a check or use detected project scripts to validate changes before review.</p>
        <button
          type="button"
          data-method="checks.list"
          onClick={() => onAction({ method: "checks.list", label: "Add check", projectId: checkRuns[0]?.projectId })}
        >
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
        <CheckRunGroup title="Active" runs={activeRuns} emptyText="No active check runs." onAction={onAction} />
        <CheckRunGroup title="Recent" runs={recentRuns} emptyText="No recent check runs." onAction={onAction} />
      </div>
      <button
        type="button"
        data-method="checks.run"
        onClick={() =>
          onAction({
            method: "checks.run",
            label: "Run checks",
            projectId: checkRuns[0]?.projectId,
            checkId: checkRuns[0]?.checkId
          })
        }
      >
        Run checks
      </button>
    </section>
  );
}

function CheckRunGroup({
  title,
  runs,
  emptyText,
  onAction
}: {
  title: string;
  runs: CheckRunViewModel[];
  emptyText: string;
  onAction(action: PendingActionRequest): void;
}) {
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
              <button
                type="button"
                data-method={run.status === "running" ? "checks.cancel" : "checks.run"}
                onClick={() =>
                  onAction({
                    method: run.status === "running" ? "checks.cancel" : "checks.run",
                    label: run.status === "running" ? "Cancel" : "Rerun",
                    projectId: run.projectId,
                    checkId: run.checkId,
                    runId: run.runId
                  })
                }
              >
                {run.status === "running" ? "Cancel" : "Rerun"}
              </button>
              {run.status === "failed" && run.required ? (
                <button
                  type="button"
                  data-method="checks.waive"
                  onClick={() =>
                    onAction({
                      method: "checks.waive",
                      label: "Waive",
                      projectId: run.projectId,
                      checkId: run.checkId,
                      runId: run.runId
                    })
                  }
                >
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
          <button type="button" data-method="checks.run" disabled title="Open a project workspace to rerun a specific check.">
            Rerun failed checks
          </button>
          <button type="button" data-method="agents.sendTurn" disabled title="Open an agent run to send an instruction.">
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

function SettingsPanel({
  apiStatus,
  providers,
  onRoute
}: {
  apiStatus: ApiStatus;
  providers: ProviderStatusViewModel[];
  onRoute(route: Route): void;
}) {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [diagnostics, setDiagnostics] = useState<ObservabilityDiagnostics>(demoDiagnostics());
  const [debugExportPreviewOpen, setDebugExportPreviewOpen] = useState(false);
  const [pendingRawLogChange, setPendingRawLogChange] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>();
  const [providerCheckMessage, setProviderCheckMessage] = useState<string | undefined>();
  const [message, setMessage] = useState("Settings are ready.");
  const selectedProvider = providers.find((provider) => provider.providerId === selectedProviderId);

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

  function configureProvider(providerIdValue: string) {
    setSelectedProviderId(providerIdValue);
    setProviderCheckMessage(undefined);
  }

  async function checkProviderAvailability(providerIdValue: string) {
    setSelectedProviderId(providerIdValue);
    setProviderCheckMessage("Checking provider availability.");
    const availability = await callApi<ProviderAvailability>("providers.checkAvailability", { providerId: providerIdValue }).catch(
      (error: unknown) => undefined
    );
    if (!availability) {
      setProviderCheckMessage("Availability check needs the local runtime API.");
      return;
    }
    setProviderCheckMessage(
      availability.status === "available"
        ? `Availability check passed${availability.version ? ` with version ${availability.version}` : ""}.`
        : `Availability check reported ${availability.status}: ${availability.reason ?? "no reason provided"}.`
    );
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
        <p>Provider-specific configuration and status live under Settings advanced controls so projects remain provider-neutral.</p>
        <button
          type="button"
          data-method="providers.getStatus"
          onClick={() => {
            onRoute("Settings");
            setSelectedProviderId(providers[0]?.providerId ?? "new-provider");
          }}
        >
          Open provider status
        </button>
      </section>
      <section className="settingsGroup" aria-label="Advanced provider status">
        <h3>Advanced provider status</h3>
        <ProviderGrid
          providers={providers}
          onConfigureProvider={configureProvider}
          onCheckAvailability={(providerIdValue) => void checkProviderAvailability(providerIdValue)}
        />
        <ProviderConfigurationPanel
          provider={selectedProvider}
          selectedProviderId={selectedProviderId}
          checkMessage={providerCheckMessage}
          settings={settings}
          providers={providers}
          onCheckAvailability={(providerIdValue) => void checkProviderAvailability(providerIdValue)}
          onUpdateSettings={(patch) => void updateSettings(patch)}
        />
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
          <div>
            <dt>Snapshot samples</dt>
            <dd>{diagnostics.metrics.dashboardSnapshotGenerationMs.count}</dd>
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
        <li>
          Metrics: event ingestion, projection timing, provider latency, approval wait, turn, command, check, API latency, and snapshot
          generation summaries.
        </li>
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
      dashboardSnapshotGeneration: [],
      providerEventIngestionLatencyMs: emptyStats(),
      approvalWaitTimeMs: emptyStats(),
      agentTurnDurationMs: emptyStats(),
      commandDurationMs: emptyStats(),
      checkDurationMs: emptyStats(),
      apiLatencyMs: emptyStats(),
      dashboardSnapshotGenerationMs: emptyStats(),
      staleSessionCount: 0,
      eventNormalizationFailureCount: 0
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

function modeQuestion(mode: DashboardProjection["mode"]) {
  return {
    portfolio: "What is the overall state of my projects?",
    active_work: "What is running now?",
    approval_center: "What needs my decision?",
    failure_triage: "What broke and what should happen next?",
    diff_review: "What changed and is it safe to keep?",
    planning: "What is being planned now?",
    stale_sessions: "Which sessions need recovery?",
    unsafe_attention: "What is risky right now?",
    single_project_focus: "What is happening in this project?"
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
          providerId: "fake" as ApprovalCardViewModel["providerId"],
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
      profileFacets: ["Software workspace", "build", "test", "repository", "code patch"],
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
      currentWorkItemTitle: "Implement provider-neutral control",
      activeAgentCount: 1,
      waitingAgentCount: approvals.length > 0 ? 1 : 0,
      blockedAgentCount: 0,
      latestArtifactTitle: "Provider control patch",
      reviewCheckStatus: approvals.length > 0 ? "Decision needed" : "Ready to review",
      lastActivityAt: now,
      badges: approvals.length > 0 ? [{ label: "Approval pending", tone: "waiting" }] : [{ label: "Review", tone: "review" }],
      primaryAction: { id: "open-workspace", label: "Open workspace", method: "projects.getWorkspace" },
      secondaryActions: [
        approvals.length > 0
          ? { id: "open-approvals", label: "Open approvals", method: "agents.respondToApproval" }
          : { id: "mark-reviewed", label: "Mark reviewed", method: "projects.markReadyToMerge" },
        { id: "open-evidence", label: "Open evidence", method: "dashboard.explainMode" }
      ],
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
      profileFacets: ["Software workspace", "maintain", "repository", "check result"],
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
      currentWorkItemTitle: "Repair package checks",
      activeAgentCount: 0,
      waitingAgentCount: 0,
      blockedAgentCount: 1,
      latestArtifactTitle: "Failed test output",
      reviewCheckStatus: "Required check failed",
      badges: [{ label: "Required check failed", tone: "failed" }],
      primaryAction: { id: "open-workspace", label: "Open workspace", method: "projects.getWorkspace" },
      secondaryActions: [
        { id: "rerun-checks", label: "Rerun failed checks", method: "checks.run" },
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
  const recentArtifacts = [
    {
      id: "artifact-alpha",
      projectId: "project-alpha",
      workItemId: "work-alpha",
      agentRunId: "run-alpha",
      type: "code_patch",
      title: "Provider control patch",
      summary: "A proposed implementation patch with linked review evidence.",
      status: "proposed",
      contentRef: "workspace://artifact/provider-control-patch",
      sourceIds: ["source-alpha"],
      evidence: alphaEvidence,
      createdAt: now,
      updatedAt: now,
      metadata: {}
    },
    {
      id: "artifact-beta",
      projectId: "project-beta",
      workItemId: "work-beta",
      agentRunId: "run-beta",
      type: "test_or_check_result",
      title: "Failed test output",
      summary: "Required check output linked to changed files.",
      status: "reviewed",
      contentRef: "workspace://artifact/failed-test-output",
      sourceIds: ["source-beta"],
      evidence: betaEvidence,
      createdAt: now,
      updatedAt: now,
      metadata: {}
    }
  ] as DashboardProjection["home"]["recentArtifacts"];
  const runningAgents = [
    {
      runId: "run-alpha",
      projectId: "project-alpha",
      workItemId: "work-alpha",
      roleName: "Builder",
      rolePreset: "builder",
      providerLabel: "Fake provider",
      providerId: "fake",
      linkedWorkItemTitle: "Implement provider-neutral control",
      status: approvals.length > 0 ? "waiting_for_approval" : "reviewing",
      lastEvent: approvals.length > 0 ? "approval.requested" : "agent.fileChange.proposed",
      pendingDecisionCount: approvals.length,
      pendingInput: false,
      producedArtifactCount: 1,
      primaryAction: approvals.length > 0
        ? { id: "open-decision-center", label: "Open decision center", method: "agents.respondToApproval" }
        : { id: "review-output", label: "Review output", method: "artifacts.markReviewed" },
      evidence: alphaEvidence,
      advanced: {
        sessionId: "session-alpha",
        providerSessionExternalKind: "runtime session"
      }
    }
  ] as AgentRunCardViewModel[];
  const selectedWorkspace = {
    projectId: "project-alpha",
    header: {
      name: "Control Plane",
      profileFacets: projectCards[0]?.profileFacets ?? [],
      state: projectCards[0]?.runtimeState ?? "idle",
      activeWorkCount: 1,
      runningAgentCount: 1,
      pendingDecisionCount: approvals.length,
      latestArtifact: recentArtifacts[0],
      primaryAction: { id: "create-work-item", label: "Create work item", method: "workItems.create" }
    },
    workItems: {
      current: [
        {
          id: "work-alpha",
          projectId: "project-alpha",
          title: "Implement provider-neutral control",
          goal: "Build the control plane without provider-specific assumptions.",
          workModes: ["build", "test", "review"],
          status: approvals.length > 0 ? "waiting_for_approval" : "reviewing",
          priority: 1,
          sourceIds: ["source-alpha"],
          artifactIds: ["artifact-alpha"],
          createdAt: now,
          updatedAt: now,
          metadata: {}
        }
      ],
      queued: [],
      blocked: [],
      completed: []
    },
    agentBoard: {
      queued: [],
      running: approvals.length > 0 ? [] : runningAgents,
      waiting: approvals.length > 0 ? runningAgents : [],
      blocked: [],
      review: approvals.length > 0 ? [] : runningAgents,
      done: []
    },
    sources: [
      {
        id: "source-alpha",
        projectId: "project-alpha",
        type: "repository",
        title: "Workspace repository",
        uriOrPath: "workspace/control-plane",
        addedBy: "system",
        createdAt: now,
        updatedAt: now,
        metadata: {},
        usedByWorkItemIds: ["work-alpha"]
      },
      {
        id: "source-alpha-note",
        projectId: "project-alpha",
        type: "note",
        title: "Review notes",
        contentRef: "workspace://source/review-notes",
        addedBy: "user",
        createdAt: now,
        updatedAt: now,
        metadata: {},
        usedByWorkItemIds: ["work-alpha"]
      }
    ],
    artifacts: [recentArtifacts[0]],
    decisions: approvals,
    timeline: [
      {
        id: "event-approval",
        kind: "approval",
        eventType: "approval.requested",
        projectId: "project-alpha",
        providerId: "fake",
        sessionId: "session-alpha",
        turnId: "turn-alpha",
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
        projectId: "project-alpha",
        providerId: "fake",
        sessionId: "session-alpha",
        turnId: "turn-alpha",
        title: "agent.turn.started",
        summary: "Run the check",
        timestamp: now,
        status: "in_progress",
        evidence: alphaEvidence,
        expandable: true
      },
      {
        id: "event-file",
        kind: "file_change",
        eventType: "agent.fileChange.proposed",
        projectId: "project-alpha",
        providerId: "fake",
        sessionId: "session-alpha",
        turnId: "turn-alpha",
        title: "agent.fileChange.proposed",
        summary: "src/new-file.ts",
        timestamp: now,
        status: "proposed",
        evidence: alphaEvidence,
        expandable: true
      }
    ]
  } as unknown as NonNullable<DashboardProjection["selectedWorkspace"]>;

  return {
    mode,
    focusedProjectId: undefined,
    home: {
      workInbox: approvals.map((approval) => ({
        id: approval.approvalId,
        projectId: "project-alpha" as ProjectCardViewModel["projectId"],
        title: approval.title,
        summary: approval.summary,
        action: { id: "open-decision-center", label: "Open decision center", method: "agents.respondToApproval" },
        timestamp: approval.requestedAt
      })),
      activeProjects: projectCards,
      waitingDecisions: approvals,
      runningAgents,
      blockedWork: [
        {
          id: "blocked-beta",
          projectId: "project-beta" as ProjectCardViewModel["projectId"],
          title: "Repair package checks",
          summary: "A required check failed.",
          action: { id: "open-workspace-project-beta", label: "Open workspace", method: "projects.getWorkspace" },
          timestamp: now
        }
      ],
      readyToReview: projectCards.filter((project) => project.runtimeState === "ready_for_review"),
      recentArtifacts,
      quickCreate: [
        { id: "create-project", label: "Create project", method: "projects.register" },
        { id: "add-source", label: "Add source", method: "projects.addSource" },
        { id: "create-work-item", label: "Create work item", method: "workItems.create" },
        { id: "start-agent-run", label: "Start agent run", method: "agentRuns.start" },
        { id: "ask-in-project", label: "Ask within selected project", method: "agentRuns.sendInstruction" },
        { id: "create-artifact", label: "Create artifact", method: "artifacts.create" },
        { id: "open-decisions", label: "Open decision center", method: "agents.respondToApproval" }
      ],
      questions: [
        "What needs my decision?",
        "What is running?",
        "What is blocked?",
        "What produced something new?",
        "Which project should I open next?",
        "What can I start now?"
      ]
    },
    selectedWorkspace,
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
      },
      {
        runId: "check-run-alpha-recent" as CheckRunViewModel["runId"],
        checkId: "check-definition-alpha-recent" as CheckRunViewModel["checkId"],
        projectId: "project-alpha" as CheckRunViewModel["projectId"],
        projectTitle: "Control Plane",
        name: "npm test",
        command: ["npm", "test"],
        status: "failed",
        required: true,
        startedAt: now,
        completedAt: now,
        durationMs: 1240,
        exitCode: 1,
        output: "src/example.ts: expected value to pass",
        relatedFiles: ["src/example.ts", "package.json"],
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
