import { expect, test } from "@playwright/test";
import type { DashboardProjection, ProjectCardViewModel, TimelineItemViewModel } from "../../src/dashboard/types";

test("dashboard shell uses provider-neutral language and keyboard focus", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Approval center" }).first()).toBeVisible();
  await expect(page.getByText("What needs my decision?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept once" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText("Decisions");
  await expect(page.getByRole("navigation", { name: "Primary" })).not.toContainText("Threads");
  await expect(page.getByRole("navigation", { name: "Primary" })).not.toContainText("Chats");
  const approval = page.getByRole("article", { name: "Run project command, high risk" });
  await expect(approval).toContainText("Session");
  await expect(approval).toContainText("session-alpha");
  await expect(approval).toContainText("Evidence");

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("dashboard modes expose primary user questions", async ({ page }) => {
  const questions: Array<[DashboardProjection["mode"], string]> = [
    ["portfolio", "What is the overall state of my projects?"],
    ["active_work", "What is running now?"],
    ["approval_center", "What needs my decision?"],
    ["failure_triage", "What broke and what should happen next?"],
    ["diff_review", "What changed and is it safe to keep?"],
    ["planning", "What is being planned now?"],
    ["stale_sessions", "Which sessions need recovery?"],
    ["unsafe_attention", "What is risky right now?"],
    ["single_project_focus", "What is happening in this project?"]
  ];
  let currentMode: DashboardProjection["mode"] = "portfolio";

  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? emptyDashboard({ mode: currentMode }) : {}
      })
    });
  });

  for (const [mode, question] of questions) {
    currentMode = mode;
    await page.goto("/");
    await expect(page.getByText(question)).toBeVisible();
  }
});

test("unsafe mode is visually distinct from active work", async ({ page }) => {
  let currentMode: DashboardProjection["mode"] = "unsafe_attention";
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? emptyDashboard({ mode: currentMode }) : {}
      })
    });
  });

  await page.goto("/");
  const topBar = page.locator(".topBar");
  await expect(topBar).toHaveCSS("border-bottom-color", "rgb(198, 93, 93)");
  await expect(topBar).toHaveCSS("background-color", "rgb(255, 247, 247)");

  currentMode = "active_work";
  await page.goto("/");
  await expect(topBar).toHaveCSS("border-bottom-color", "rgb(122, 167, 199)");
  await expect(topBar).not.toHaveCSS("background-color", "rgb(255, 247, 247)");
});

test("approval center can be resolved with keyboard", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Decline" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Diff review" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark reviewed" }).first()).toHaveAttribute(
    "data-method",
    "projects.markReadyToMerge"
  );
  await expect(page.getByRole("button", { name: "Accept once" })).toHaveCount(0);
});

test("risky approval decisions require confirmation and stay keyboard usable", async ({ page }) => {
  await page.goto("/");

  const acceptOnce = page.getByRole("button", { name: "Accept once" });
  await expect(acceptOnce).toHaveAttribute("data-method", "agents.respondToApproval");
  await acceptOnce.focus();
  await page.keyboard.press("a");

  const dialog = page.getByRole("dialog", { name: "Confirm approval decision" });
  await expect(dialog).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirm decision" });
  await expect(confirm).toHaveAttribute("data-method", "agents.respondToApproval");
  await expect(confirm).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Keep pending" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(dialog).toHaveCount(0);
  await expect(acceptOnce).toBeVisible();
  await acceptOnce.click();
  await expect(dialog).toBeVisible();
  await confirm.click();

  await expect(page.getByRole("heading", { name: "Diff review" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept once" })).toHaveCount(0);
});

test("compact layout keeps approval decisions visible and renders details as a drawer", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto("/");

  const acceptOnce = page.getByRole("button", { name: "Accept once" });
  await expect(acceptOnce).toBeVisible();
  await expect(acceptOnce).toBeInViewport();

  const workspace = page.getByRole("region", { name: "Home workspace" });
  const detailDrawer = page.getByRole("complementary", { name: "Details" });
  await expect(detailDrawer).toBeVisible();
  await expect(detailDrawer).toContainText("Selected project");

  const workspaceBox = await workspace.boundingBox();
  const drawerBox = await detailDrawer.boundingBox();
  expect(drawerBox?.y).toBeGreaterThan(workspaceBox?.y ?? 0);
});

test("project card state remains understandable without color", async ({ page }) => {
  await page.goto("/");

  const packageMetadata = page.getByRole("article").filter({ hasText: "Package Metadata" });
  await expect(packageMetadata.locator(".stateBadge", { hasText: "Required check failed" })).toBeVisible();
  await expect(packageMetadata).toContainText("1 required check failed.");
  await expect(packageMetadata.getByRole("button", { name: "Rerun failed checks" })).toBeVisible();
});

test("reduced motion disables non-essential animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const transitionDuration = await page
    .getByRole("article")
    .filter({ hasText: "Control Plane" })
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);

  expect(parseCssDurations(transitionDuration).every((durationMs) => durationMs <= 0.01)).toBe(true);
});

test("global UI avoids runtime-provider names", async ({ page }) => {
  await page.goto("/");
  const body = await page.locator("body").innerText();

  expect(body).not.toMatch(/OpenAI|Anthropic|Gemini|Claude|Codex/);
});

test("activity timeline filters by project, provider, session, and event type", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? timelineFilterDashboard() : {}
      })
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Activity" }).click();
  const started = page.getByRole("heading", { name: "agent.turn.started" });
  const approval = page.getByRole("heading", { name: "approval.requested" });
  const check = page.getByRole("heading", { name: "check.failed" });

  await expect(started).toBeVisible();
  await expect(approval).toBeVisible();
  await expect(check).toBeVisible();

  await page.getByLabel("Filter by project").selectOption("project-a");
  await expect(started).toBeVisible();
  await expect(approval).toHaveCount(0);
  await expect(check).toHaveCount(0);

  await page.getByLabel("Filter by project").selectOption("all");
  await page.getByLabel("Filter by provider").selectOption("provider-b");
  await expect(approval).toBeVisible();
  await expect(started).toHaveCount(0);
  await expect(check).toHaveCount(0);

  await page.getByLabel("Filter by provider").selectOption("all");
  await page.getByLabel("Filter by session").selectOption("session-c");
  await expect(check).toBeVisible();
  await expect(started).toHaveCount(0);
  await expect(approval).toHaveCount(0);

  await page.getByLabel("Filter by session").selectOption("all");
  await page.getByLabel("Filter by event type").selectOption("agent.turn.started");

  await expect(started).toBeVisible();
  await expect(approval).toHaveCount(0);
  await expect(check).toHaveCount(0);
});

test("activity timeline groups by turn and expands details lazily", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Activity" }).click();
  const turnGroup = page.getByRole("region", { name: "Turn turn-alpha" });
  await expect(turnGroup).toContainText("3 events");
  await expect(turnGroup.getByRole("heading", { name: "approval.requested" })).toBeVisible();
  await expect(turnGroup.getByRole("heading", { name: "agent.fileChange.proposed" })).toBeVisible();
  await expect(page.getByText("provider.rawEvent")).toHaveCount(0);

  const fileChangeItem = turnGroup.locator("article").filter({ hasText: "agent.fileChange.proposed" });
  await expect(fileChangeItem.getByText("Evidence")).toHaveCount(0);
  await fileChangeItem.getByRole("button", { name: "Show details" }).click();
  await expect(fileChangeItem.getByText("Evidence")).toBeVisible();
  await expect(fileChangeItem.getByText("agent.fileChange.proposed").first()).toBeVisible();
  await expect(fileChangeItem.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
});

test("project cards support keyboard navigation and provider-neutral action mappings", async ({ page }) => {
  await page.goto("/");

  const controlPlane = page.getByRole("button", { name: /Control Plane/ }).first();
  const packageMetadata = page.getByRole("button", { name: /Package Metadata/ }).first();
  await controlPlane.focus();
  await expect(controlPlane).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");

  await expect(packageMetadata).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("Package Metadata");
  await expect(page.getByRole("button", { name: "Rerun failed checks" }).first()).toHaveAttribute("data-method", "checks.run");
  const packageCard = page.getByRole("article").filter({ hasText: "Package Metadata" });
  const openEvidence = packageCard.getByRole("button", { name: "Open evidence" });
  await expect(openEvidence).toHaveAttribute("data-method", "dashboard.explainMode");
  await openEvidence.click();

  const projectEvidence = page.getByRole("region", { name: "Project evidence" });
  await expect(projectEvidence).toBeFocused();
  await expect(projectEvidence).toContainText("Evidence for Package Metadata");
  await expect(projectEvidence).toContainText("failed required check blocks review");
  await expect(projectEvidence.getByRole("list", { name: "Evidence references" })).toContainText("Check check-run-beta failed");
});

test("disabled project actions expose provider-neutral reason text", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result:
          request.method === "dashboard.getSnapshot"
            ? emptyDashboard({ projectCards: [disabledActionProjectCard()] })
            : {}
      })
    });
  });
  await page.goto("/");

  const project = page.getByRole("article").filter({ hasText: "Capability gated project" });
  await expect(project.getByRole("button", { name: "Start task" })).toBeDisabled();
  await expect(project.getByRole("list", { name: "Unavailable actions" })).toContainText(
    "Provider does not support starting sessions."
  );
});

test("diff review supports file search, source links, renames, and binary metadata", async ({ page }) => {
  await page.goto("/");

  const diffRegion = page.getByRole("region", { name: "Diff preview" });
  await expect(diffRegion).toContainText("src/new-file.ts");
  await expect(diffRegion).toContainText("session-alpha");
  await expect(diffRegion).toContainText("turn-alpha");

  await page.getByLabel("Search diff files").fill("logo");
  await page.getByRole("option", { name: /assets\/logo\.bin/ }).click();
  await expect(diffRegion).toContainText("Binary file metadata only.");

  await page.getByLabel("Search diff files").fill("current-name");
  await page.getByRole("option", { name: /src\/current-name\.ts/ }).click();
  await expect(diffRegion).toContainText("src/old-name.ts");
  await expect(diffRegion).toContainText("renamed to");
});

test("check run panel shows active and recent runs with triage links", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Projects/ }).click();
  await expect(page.getByRole("region", { name: "Project Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Checks inside project workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check runs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Active" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();

  const recentRuns = page.getByRole("region", { name: "Recent check runs" });
  await expect(recentRuns.getByRole("heading", { name: "npm test" })).toBeVisible();
  await expect(recentRuns.getByText("Exit code")).toBeVisible();
  await expect(recentRuns.getByText("1.2 s")).toBeVisible();
  await expect(recentRuns.getByText("src/example.ts: expected value to pass")).toBeVisible();
  await expect(recentRuns.getByRole("link", { name: "src/example.ts" })).toHaveAttribute("data-method", "git.openDiff");
  await expect(recentRuns.getByRole("button", { name: "Waive" })).toHaveAttribute("data-method", "checks.waive");
  await expect(page.getByRole("region", { name: "Active check runs" }).getByRole("button", { name: "Cancel" })).toHaveAttribute(
    "data-method",
    "checks.cancel"
  );
  await expect(page.getByRole("button", { name: "Run checks" })).toHaveAttribute("data-method", "checks.run");
});

test("provider status cards show capability and compatibility details", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Advanced provider status" })).toBeVisible();

  const fakeProvider = page.getByRole("article").filter({ hasText: "Fake provider" });
  await expect(fakeProvider).toContainText("Adapter version 0.1.0");
  await expect(fakeProvider).toContainText("Availability");
  await expect(fakeProvider).toContainText("compatible");
  await expect(fakeProvider.getByRole("list", { name: "Fake provider capabilities" })).toContainText("Start sessions");
  await expect(fakeProvider.getByText("supported").first()).toBeVisible();
  await expect(fakeProvider.getByRole("button", { name: "Check availability" })).toHaveAttribute(
    "data-method",
    "providers.checkAvailability"
  );
  const configureFake = fakeProvider.getByRole("button", { name: "Configure provider" });
  await expect(configureFake).toHaveAttribute("data-method", "providers.getStatus");
  await configureFake.click();
  const providerConfiguration = page.getByRole("region", { name: "Provider configuration" });
  await expect(providerConfiguration).toBeFocused();
  await expect(providerConfiguration).toContainText("Fake provider configuration");
  await expect(providerConfiguration).toContainText("Provider id");

  const unavailableProvider = page.getByRole("article").filter({ hasText: "Unavailable provider" });
  await expect(unavailableProvider).toContainText("unavailable");
  await expect(unavailableProvider).toContainText("Provider is not configured.");
  await expect(unavailableProvider.getByRole("list", { name: "Unavailable provider capabilities" })).toContainText("unavailable");
});

test("settings panel confirms raw provider logs and keeps provider settings separate", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const settingsPanel = page.getByRole("region", { name: "Settings panel" });
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel.getByRole("region", { name: "Logging" })).toContainText("disabled");

  const enableLogs = settingsPanel.getByRole("button", { name: "Enable raw provider logs" });
  await expect(enableLogs).toHaveAttribute("data-method", "settings.update");
  await enableLogs.click();

  const dialog = page.getByRole("dialog", { name: "Confirm logging change" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable raw logs" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Keep disabled" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsPanel.getByRole("region", { name: "Logging" })).toContainText("disabled");

  await enableLogs.click();
  await page.getByRole("button", { name: "Enable raw logs" }).click();
  await expect(settingsPanel.getByRole("region", { name: "Logging" })).toContainText("enabled");
  await expect(settingsPanel.getByRole("button", { name: "Disable raw provider logs" })).toHaveAttribute("data-method", "settings.update");
  await expect(settingsPanel.getByRole("region", { name: "Provider settings placement" })).toContainText("under Settings");
  await expect(settingsPanel.getByRole("button", { name: "Open provider status" })).toHaveAttribute("data-method", "providers.getStatus");

  const diagnostics = settingsPanel.getByRole("region", { name: "Diagnostics" });
  await expect(diagnostics).toContainText("replay ok");
  await expect(diagnostics).toContainText("Snapshot samples");
  const reviewDebugExport = diagnostics.getByRole("button", { name: "Review debug export" });
  await expect(reviewDebugExport).toHaveAttribute("data-method", "diagnostics.get");
  await reviewDebugExport.click();

  const debugPreview = diagnostics.getByRole("region", { name: "Debug export preview" });
  await expect(debugPreview).toContainText("Provider log");
  await expect(debugPreview).toContainText("Event log");
  await expect(debugPreview).toContainText("Projection inspector");
  await expect(debugPreview).toContainText("Safety inspector");
  await expect(debugPreview).toContainText("snapshot generation");
  await expect(debugPreview).toContainText("Raw provider logs");
  await expect(debugPreview).toContainText("[REDACTED]");
});

test("command palette opens from global search and runs provider-neutral commands", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.getByLabel("Search commands").fill("provider");

  const providerCommand = page.getByRole("option", { name: /Show provider status/ });
  await expect(providerCommand).toHaveAttribute("data-method", "providers.getStatus");
  await providerCommand.click();

  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-method", "events.query");
  await page.getByLabel("Search commands").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
});

test("empty states expose provider-neutral next actions", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    if (request.method === "dashboard.getSnapshot") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: emptyDashboard() })
      });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ id: request.id, error: { message: "No mocked response." } })
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Projects" }).click();
  const projects = page.getByRole("region", { name: "Projects" });
  await expect(projects.getByRole("heading", { name: "No projects registered" })).toBeVisible();
  await expect(projects.getByRole("button", { name: "Register project" })).toHaveAttribute("data-method", "projects.register");
  await expect(projects.getByRole("button", { name: "Provider setup" })).toHaveAttribute("data-method", "providers.getStatus");

  await page.getByRole("button", { name: "Decisions" }).click();
  const approvals = page.getByRole("region", { name: "Approval center" });
  await expect(approvals.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  await expect(approvals.getByRole("button", { name: "Recent decisions" })).toHaveAttribute("data-method", "events.query");

  await page.getByRole("button", { name: "Artifacts" }).click();
  const artifacts = page.getByRole("region", { name: "Artifacts" });
  await expect(artifacts.getByText("No artifacts yet")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const providers = page.getByRole("region", { name: "Advanced provider status" });
  await expect(providers.getByRole("heading", { name: "No providers configured" })).toBeVisible();
  await expect(providers).toContainText("fake provider remains available");
  const configureProvider = providers.getByRole("button", { name: "Configure provider" });
  await expect(configureProvider).toHaveAttribute("data-method", "providers.list");
  await configureProvider.click();
  await expect(page.getByRole("region", { name: "Provider configuration" })).toContainText("No provider is selected");
});

function parseCssDurations(value: string): number[] {
  return value.split(",").map((duration) => {
    const trimmed = duration.trim();
    if (trimmed.endsWith("ms")) return Number(trimmed.slice(0, -2));
    if (trimmed.endsWith("s")) return Number(trimmed.slice(0, -1)) * 1000;
    return Number(trimmed);
  });
}

function emptyDashboard(overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  const mode = overrides.mode ?? "portfolio";
  return {
    mode,
    home: {
      workInbox: [],
      activeProjects: [],
      waitingDecisions: [],
      runningAgents: [],
      blockedWork: [],
      readyToReview: [],
      recentArtifacts: [],
      quickCreate: [],
      questions: [
        "What needs my decision?",
        "What is running?",
        "What is blocked?",
        "What produced something new?",
        "Which project should I open next?",
        "What can I start now?"
      ],
      ...overrides.home
    },
    selectedWorkspace: overrides.selectedWorkspace,
    globalStatus: {
      activeProjectCount: 0,
      activeTurnCount: 0,
      pendingApprovalCount: 0,
      failedCheckCount: 0,
      staleSessionCount: 0,
      unsafeStateCount: 0,
      providerIssues: [],
      ...overrides.globalStatus
    },
    projectCards: [],
    approvals: [],
    checkRuns: [],
    providerStatus: [],
    timeline: [],
    explanation: {
      mode,
      propositions: [],
      evidence: [],
      ...overrides.explanation
    },
    ...overrides
  };
}

function disabledActionProjectCard(): ProjectCardViewModel {
  return {
    projectId: "project-disabled" as ProjectCardViewModel["projectId"],
    title: "Capability gated project",
    subtitle: "/workspace/capability-gated",
    profileFacets: ["Project workspace", "custom", "local folder"],
    runtimeState: "idle",
    urgency: 0,
    stateLabel: "Idle",
    stateReason: "No urgent state detected.",
    providerLabel: "Limited provider",
    branchLabel: "main",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    failedCheckCount: 0,
    activeTurnCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    badges: [{ label: "Idle", tone: "idle" }],
    primaryAction: {
      id: "start-task",
      label: "Start task",
      method: "agents.startSession",
      disabled: true,
      disabledReason: "Provider does not support starting sessions."
    },
    secondaryActions: [],
    diffFiles: [],
    evidence: []
  };
}

function timelineFilterDashboard(): DashboardProjection {
  return emptyDashboard({
    timeline: [
      timelineItem({
        id: "timeline-started",
        eventType: "agent.turn.started",
        kind: "turn",
        projectId: "project-a",
        providerId: "provider-a",
        sessionId: "session-a",
        turnId: "turn-a"
      }),
      timelineItem({
        id: "timeline-approval",
        eventType: "approval.requested",
        kind: "approval",
        projectId: "project-b",
        providerId: "provider-b",
        sessionId: "session-b",
        turnId: "turn-b"
      }),
      timelineItem({
        id: "timeline-check",
        eventType: "check.failed",
        kind: "check",
        projectId: "project-b",
        providerId: "provider-a",
        sessionId: "session-c",
        turnId: "turn-c"
      })
    ]
  });
}

function timelineItem(input: {
  id: string;
  eventType: string;
  kind: TimelineItemViewModel["kind"];
  projectId: string;
  providerId: string;
  sessionId: string;
  turnId: string;
}): TimelineItemViewModel {
  return {
    id: input.id,
    eventType: input.eventType,
    kind: input.kind,
    projectId: input.projectId as TimelineItemViewModel["projectId"],
    providerId: input.providerId as TimelineItemViewModel["providerId"],
    sessionId: input.sessionId as TimelineItemViewModel["sessionId"],
    turnId: input.turnId as TimelineItemViewModel["turnId"],
    title: input.eventType,
    summary: input.eventType,
    timestamp: new Date(0).toISOString(),
    status: "reported",
    evidence: [],
    expandable: true
  };
}
