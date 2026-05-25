import { expect, test } from "@playwright/test";
import type {
  ProjectArtifact,
  ProjectSource,
  ProjectWorkItem
} from "../../src/core";
import type {
  AgentRunCardViewModel,
  DashboardProjection,
  ProjectCardViewModel,
  ProviderStatusViewModel,
  TimelineItemViewModel
} from "../../src/dashboard/types";

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

test("home work inbox routes decision actions", async ({ page }) => {
  await page.goto("/");

  const workInbox = page.getByRole("region", { name: "Work inbox" });
  const openDecisionCenter = workInbox.getByRole("button", { name: "Open decision center" });
  await expect(openDecisionCenter).toHaveAttribute("data-method", "agents.respondToApproval");
  await openDecisionCenter.click();

  await expect(page.getByRole("button", { name: "Decisions" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Approval center" })).toBeVisible();
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
  const markReviewed = page.getByRole("button", { name: "Mark reviewed" }).first();
  await expect(markReviewed).toHaveAttribute(
    "data-method",
    "projects.markReadyToMerge"
  );
  await markReviewed.click();
  const markReviewedDialog = page.getByRole("dialog", { name: "Mark reviewed" });
  await expect(markReviewedDialog).toBeVisible();
  await expect(markReviewedDialog.getByRole("checkbox", { name: "Confirm if the project branch is out of date" })).toBeVisible();
  await expect(markReviewedDialog.getByRole("button", { name: "Run action" })).toHaveAttribute("data-method", "projects.markReadyToMerge");
  await markReviewedDialog.getByRole("button", { name: "Cancel" }).click();
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
  await packageMetadata.getByRole("button", { name: "Rerun failed checks" }).click();

  const rerunDialog = page.getByRole("dialog", { name: "Rerun failed checks" });
  await expect(rerunDialog).toBeVisible();
  await expect(rerunDialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Package Metadata");
  await expect(rerunDialog.getByRole("combobox", { name: "Check", exact: true })).toContainText("test");
  await expect(rerunDialog.getByRole("button", { name: "Run action" })).toHaveAttribute("data-method", "checks.run");
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

test("demo cockpit includes non-code project work", async ({ page }) => {
  await page.goto("/");

  const researchBrief = page.getByRole("article").filter({ hasText: "Research Brief" });
  await expect(researchBrief).toContainText("research");
  await expect(researchBrief).toContainText("analyze");
  await expect(researchBrief).toContainText("Synthesize source notes");
  await expect(researchBrief).toContainText("Source-linked notes");
  await expect(researchBrief.getByRole("button", { name: "Open workspace" })).toHaveAttribute("data-method", "projects.getWorkspace");
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
  const relatedFile = recentRuns.getByRole("link", { name: "src/example.ts" });
  await expect(relatedFile).toHaveAttribute("data-method", "git.openDiff");
  await relatedFile.click();
  await expect(page.getByRole("region", { name: "Diff review details" })).toBeFocused();
  await expect(recentRuns.getByRole("button", { name: "Waive" })).toHaveAttribute("data-method", "checks.waive");
  await expect(page.getByRole("region", { name: "Active check runs" }).getByRole("button", { name: "Cancel" })).toHaveAttribute(
    "data-method",
    "checks.cancel"
  );
  await expect(page.getByRole("button", { name: "Run checks" })).toHaveAttribute("data-method", "checks.run");
});

test("empty project check panel preserves workspace context", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    if (request.method === "dashboard.getSnapshot") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: noCheckWorkspaceDashboard() })
      });
      return;
    }
    if (request.method === "checks.list") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: request.id,
          result: [
            {
              id: "check-no-checks",
              projectId: "project-no-checks",
              name: "research review",
              command: ["npm", "run", "review"],
              cwd: "/workspace/no-checks",
              timeoutMs: 60000,
              required: true,
              source: "detected"
            }
          ]
        })
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

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Projects/ }).click();
  const checks = page.getByRole("region", { name: "Checks inside project workspace" });
  await expect(checks.getByRole("heading", { name: "No checks have run" })).toBeVisible();
  const listChecks = checks.getByRole("button", { name: "List available checks" });
  await expect(listChecks).toHaveAttribute("data-method", "checks.list");
  await listChecks.click();

  const listChecksDialog = page.getByRole("dialog", { name: "List available checks" });
  await expect(listChecksDialog).toBeVisible();
  await expect(listChecksDialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("No-check Workspace");
  const runAction = listChecksDialog.getByRole("button", { name: "Run action" });
  await expect(runAction).toHaveAttribute("data-method", "checks.list");
  await runAction.click();
  await expect(listChecksDialog.getByRole("region", { name: "Action result" })).toContainText("Available checks");
  await expect(listChecksDialog.getByRole("region", { name: "Action result" })).toContainText("research review");
});

test("project workspace action dialogs use workspace choices", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("button", { name: "Assign agents" }).click();

  const assignDialog = page.getByRole("dialog", { name: "Assign agents" });
  await expect(assignDialog).toBeVisible();
  await expect(assignDialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Control Plane");
  await expect(assignDialog.getByRole("combobox", { name: "Work item", exact: true })).toContainText("Implement provider-neutral control");
  await expect(assignDialog.getByRole("combobox", { name: "Provider", exact: true })).toContainText("Fake provider");
  await expect(assignDialog).toContainText("Agent runs are always linked to a visible work item.");
  await expect(assignDialog).not.toContainText(/thread/i);

  await assignDialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Run checks" }).click();

  const checksDialog = page.getByRole("dialog", { name: "Run checks" });
  await expect(checksDialog).toBeVisible();
  await expect(checksDialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Control Plane");
  await expect(checksDialog.getByRole("combobox", { name: "Check", exact: true })).toContainText("typecheck");
  await expect(checksDialog).toContainText("Required failed checks block review readiness");
});

test("project workspace object actions use explicit API context", async ({ page }) => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string; params?: Record<string, unknown> };
    requests.push({ method: request.method, params: request.params });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? workspaceLifecycleDashboard() : {}
      })
    });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Projects/ }).click();

  const queuedWork = page.getByRole("region", { name: "Queued work" });
  await queuedWork.getByRole("button", { name: "Queue" }).click();
  const queueDialog = page.getByRole("dialog", { name: "Queue work item" });
  await expect(queueDialog.getByRole("combobox", { name: "Work item", exact: true })).toContainText("Draft field guide");
  await queueDialog.getByRole("button", { name: "Run action" }).click();
  expect(requests.find((request) => request.method === "workItems.queue")?.params).toMatchObject({
    projectId: "project-no-checks",
    workItemId: "work-action-1"
  });

  const sources = page.getByRole("region", { name: "Sources panel" });
  await sources.getByRole("button", { name: "Remove source" }).click();
  const removeSourceDialog = page.getByRole("dialog", { name: "Remove source" });
  await expect(removeSourceDialog.getByRole("combobox", { name: "Source", exact: true })).toContainText("Interview notes");
  await removeSourceDialog.getByRole("button", { name: "Run action" }).click();
  expect(requests.find((request) => request.method === "projects.removeSource")?.params).toMatchObject({
    projectId: "project-no-checks",
    sourceId: "source-action-1"
  });

  const artifacts = page.getByRole("region", { name: "Artifacts panel" });
  await artifacts.getByRole("button", { name: "Mark reviewed" }).click();
  const reviewArtifactDialog = page.getByRole("dialog", { name: "Mark artifact reviewed" });
  await expect(reviewArtifactDialog.getByRole("combobox", { name: "Artifact", exact: true })).toContainText("Field guide draft");
  await reviewArtifactDialog.getByRole("button", { name: "Run action" }).click();
  expect(requests.find((request) => request.method === "artifacts.markReviewed")?.params).toMatchObject({
    projectId: "project-no-checks",
    artifactId: "artifact-action-1"
  });

  const runningAgents = page.getByRole("region", { name: "running agents" });
  await runningAgents.getByRole("button", { name: "Stop run" }).click();
  const stopRunDialog = page.getByRole("dialog", { name: "Stop run" });
  await expect(stopRunDialog.getByRole("combobox", { name: "Agent run", exact: true })).toContainText("Writer");
  await stopRunDialog.getByLabel("Reason").fill("User paused this work.");
  await stopRunDialog.getByRole("button", { name: "Run action" }).click();
  expect(requests.find((request) => request.method === "agentRuns.stop")?.params).toMatchObject({
    projectId: "project-no-checks",
    agentRunId: "run-action-1",
    reason: "User paused this work."
  });
});

test("import sessions project action asks for provider context before running", async ({ page }) => {
  const requestedMethods: string[] = [];
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    requestedMethods.push(request.method);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? importSessionsDashboard() : {}
      })
    });
  });

  await page.goto("/");
  const importProject = page.getByRole("article").filter({ hasText: "Import action project" });
  await importProject.getByRole("button", { name: "Import sessions" }).click();

  const dialog = page.getByRole("dialog", { name: "Import sessions" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Import action project");
  await expect(dialog.getByRole("combobox", { name: "Provider", exact: true })).toContainText("Import provider");
  expect(requestedMethods).not.toContain("agents.importSessions");
});

test("agent open details expands advanced details without a dead API dialog", async ({ page }) => {
  const requestedMethods: string[] = [];
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    requestedMethods.push(request.method);
    if (request.method === "dashboard.getSnapshot") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: agentDetailsDashboard() })
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Projects/ }).click();
  const doneAgents = page.getByRole("region", { name: "done agents" });
  const openDetails = doneAgents.getByRole("button", { name: "Open details" });
  await expect(openDetails).toHaveAttribute("data-method", "agentRuns.listByProject");
  await expect(doneAgents.getByText("session-finished")).toBeHidden();

  await openDetails.click();

  await expect(openDetails).toHaveAttribute("aria-expanded", "true");
  await expect(doneAgents.getByText("session-finished")).toBeVisible();
  expect(requestedMethods).not.toContain("agentRuns.listByProject");
});

test("project session actions open executable context dialogs", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? sessionActionDashboard() : {}
      })
    });
  });

  await page.goto("/");
  const project = page.getByRole("article").filter({ hasText: "Session action project" });
  const startTask = project.getByRole("button", { name: "Start task" });
  await expect(startTask).toHaveAttribute("data-method", "agents.startSession");
  await startTask.click();

  const dialog = page.getByRole("dialog", { name: "Start task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Session action project");
  await expect(dialog.getByRole("combobox", { name: "Provider", exact: true })).toContainText("Runnable provider");
  await expect(dialog.getByLabel("Working folder")).toHaveValue("/workspace/session-action");
  await expect(dialog.getByRole("button", { name: "Run action" })).toHaveAttribute("data-method", "agents.startSession");
});

test("start dialogs keep unavailable providers visible but unselectable", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result: request.method === "dashboard.getSnapshot" ? unavailableStartProviderDashboard() : {}
      })
    });
  });

  await page.goto("/");
  const project = page.getByRole("article").filter({ hasText: "Unavailable start project" });
  await project.getByRole("button", { name: "Start task" }).click();

  const dialog = page.getByRole("dialog", { name: "Start task" });
  const providerSelect = dialog.getByRole("combobox", { name: "Provider", exact: true });
  await expect(providerSelect).toHaveValue("provider-available");
  await expect(providerSelect.locator('option[value="provider-unavailable"]')).toHaveAttribute("disabled", "");
  await expect(providerSelect.locator('option[value="provider-available"]')).not.toHaveAttribute("disabled", "");
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
  await expect(providerConfiguration).toContainText("Next:");
  await expect(providerConfiguration.getByRole("button", { name: "Check availability" })).toHaveAttribute(
    "data-method",
    "providers.checkAvailability"
  );
  await expect(providerConfiguration.getByRole("button", { name: "Disable on next startup" })).toHaveAttribute(
    "data-method",
    "settings.update"
  );
  await expect(providerConfiguration.getByRole("button", { name: "Set as default provider" })).toHaveAttribute(
    "data-method",
    "settings.update"
  );
  await providerConfiguration.getByRole("button", { name: "Set as default provider" }).click();
  await expect(providerConfiguration).toContainText("Default");
  await expect(providerConfiguration).toContainText("yes");

  const unavailableProvider = page.getByRole("article").filter({ hasText: "Unavailable provider" });
  await expect(unavailableProvider).toContainText("unavailable");
  await expect(unavailableProvider).toContainText("Provider is not configured.");
  await expect(unavailableProvider.getByRole("list", { name: "Unavailable provider capabilities" })).toContainText("unavailable");
});

test("provider configuration shows setup steps and updates from availability checks", async ({ page }) => {
  const dashboard = emptyDashboard({
    providerStatus: [setupProviderStatus("Setup provider", "unavailable")]
  });

  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string; params?: unknown };
    if (request.method === "dashboard.getSnapshot") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: dashboard })
      });
      return;
    }
    if (request.method === "providers.checkAvailability") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: request.id,
          result: {
            status: "available",
            version: "1.2.3",
            details: setupProviderDetails("agentctl")
          }
        })
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
  await page.getByRole("button", { name: "Settings" }).click();

  const providerCard = page.getByRole("article").filter({ hasText: "Setup provider" });
  await providerCard.getByRole("button", { name: "Configure provider" }).click();

  const providerConfiguration = page.getByRole("region", { name: "Provider configuration" });
  await expect(providerConfiguration.getByRole("region", { name: "Provider setup checklist" })).toContainText("Install the provider command.");
  await expect(providerConfiguration.getByRole("region", { name: "Provider commands" })).toContainText("agentctl --version");
  await expect(providerConfiguration.getByRole("region", { name: "Provider environment overrides" })).toContainText("AGENTCTL_BIN");
  await expect(providerConfiguration.getByRole("button", { name: "Set as default provider" })).toBeDisabled();
  const commandOverride = providerConfiguration.getByLabel("Command for next startup");
  await expect(commandOverride).toHaveAttribute("placeholder", "agentctl");
  await commandOverride.fill("/opt/bin/agentctl");
  await providerConfiguration.getByRole("button", { name: "Save command override" }).click();
  await expect(providerConfiguration).toContainText("Saved override: /opt/bin/agentctl");
  await expect(providerConfiguration).toContainText("restart the local runtime to apply the saved command override");

  await providerConfiguration.getByRole("button", { name: "Check availability" }).click();
  await expect(providerConfiguration).toContainText("Availability check passed with version 1.2.3.");
  await expect(providerConfiguration.getByText("available").first()).toBeVisible();
  await expect(providerCard.getByText("available").first()).toBeVisible();
  await expect(providerConfiguration.getByRole("button", { name: "Set as default provider" })).toBeEnabled();
});

test("settings panel confirms raw provider logs and keeps provider settings separate", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const settingsPanel = page.getByRole("region", { name: "Settings panel" });
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel.getByRole("region", { name: "Logging" })).toContainText("disabled");

  const projectDiscovery = settingsPanel.getByRole("region", { name: "Project discovery" });
  await projectDiscovery.getByLabel("Project roots").fill("/workspace/research\n/workspace/writing\n/workspace/research");
  await projectDiscovery.getByRole("button", { name: "Save project roots" }).click();
  await expect(projectDiscovery.getByRole("list", { name: "Saved project roots" })).toContainText("/workspace/research");
  await expect(projectDiscovery.getByRole("list", { name: "Saved project roots" })).toContainText("/workspace/writing");
  await expect(settingsPanel).toContainText("Settings updated in the preview state.");

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

test("command palette opens executable project action flows", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByLabel("Search commands").fill("create project");
  const createProject = page.getByRole("option", { name: /Create project/ });
  await expect(createProject).toHaveAttribute("data-method", "projects.register");
  await createProject.click();

  const createProjectDialog = page.getByRole("dialog", { name: "Create project" });
  await expect(createProjectDialog).toBeVisible();
  await expect(createProjectDialog.getByLabel("Root path")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

  await createProjectDialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByLabel("Search commands").fill("run checks");
  const runChecks = page.getByRole("option", { name: /Run checks/ });
  await expect(runChecks).toHaveAttribute("data-method", "checks.run");
  await runChecks.click();

  const runChecksDialog = page.getByRole("dialog", { name: "Run checks" });
  await expect(runChecksDialog.getByRole("combobox", { name: "Project", exact: true })).toContainText("Control Plane");
  await expect(runChecksDialog.getByRole("combobox", { name: "Check", exact: true })).toContainText("typecheck");
  await runChecksDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByLabel("Search commands").fill("open diff");
  const openDiff = page.getByRole("option", { name: /Open diff review/ });
  await expect(openDiff).toHaveAttribute("data-method", "git.openDiff");
  await openDiff.click();

  await expect(page.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Diff review details" })).toBeFocused();
});

test("project-scoped composer actions do not reuse stale selected projects", async ({ page }) => {
  await page.route("**/api", async (route) => {
    const request = route.request().postDataJSON() as { id: string; method: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: request.id,
        result:
          request.method === "dashboard.getSnapshot"
            ? emptyDashboard({
                home: {
                  quickCreate: [{ id: "add-source", label: "Add source", method: "projects.addSource" }]
                }
              })
            : {}
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add source" }).click();

  const dialog = page.getByRole("dialog", { name: "Add source" });
  await expect(dialog.getByLabel("Project id")).toHaveValue("");
  await expect(dialog).toContainText("Create or select a project workspace before starting project-scoped work.");
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

  const homeProjects = page.getByRole("region", { name: "Projects" }).first();
  await expect(homeProjects.getByRole("button", { name: "Register project" })).toHaveAttribute("data-method", "projects.register");
  await homeProjects.getByRole("button", { name: "Register project" }).click();
  await expect(page.getByRole("dialog", { name: "Register project" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Projects" }).click();
  const projects = page.getByRole("region", { name: "Projects" });
  await expect(projects.getByRole("heading", { name: "No projects registered" })).toBeVisible();
  await expect(projects.getByRole("button", { name: "Register project" })).toHaveAttribute("data-method", "projects.register");
  await expect(projects.getByRole("button", { name: "Provider setup" })).toHaveAttribute("data-method", "providers.getStatus");
  await projects.getByRole("button", { name: "Provider setup" }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Decisions" }).click();
  const approvals = page.getByRole("region", { name: "Approval center" });
  await expect(approvals.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  await expect(approvals.getByRole("button", { name: "Recent decisions" })).toHaveAttribute("data-method", "events.query");
  await approvals.getByRole("button", { name: "Recent decisions" }).click();
  await expect(page.getByRole("button", { name: "Activity" })).toHaveAttribute("aria-current", "page");

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
  const providerConfiguration = page.getByRole("region", { name: "Provider configuration" });
  await expect(providerConfiguration).toContainText("No optional provider is registered");
  await expect(providerConfiguration.getByRole("list", { name: "Provider discovery checklist" })).toContainText("Restart the local runtime");
  await expect(providerConfiguration.getByRole("button", { name: "Reload provider status" })).toHaveAttribute(
    "data-method",
    "providers.checkAvailability"
  );
});

function parseCssDurations(value: string): number[] {
  return value.split(",").map((duration) => {
    const trimmed = duration.trim();
    if (trimmed.endsWith("ms")) return Number(trimmed.slice(0, -2));
    if (trimmed.endsWith("s")) return Number(trimmed.slice(0, -1)) * 1000;
    return Number(trimmed);
  });
}

type DashboardOverrides = Omit<Partial<DashboardProjection>, "home" | "globalStatus" | "explanation"> & {
  home?: Partial<DashboardProjection["home"]>;
  globalStatus?: Partial<DashboardProjection["globalStatus"]>;
  explanation?: Partial<DashboardProjection["explanation"]>;
};

function emptyDashboard(overrides: DashboardOverrides = {}): DashboardProjection {
  const { home, globalStatus, explanation, ...rest } = overrides;
  const mode = rest.mode ?? "portfolio";
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
      ...home
    },
    selectedWorkspace: rest.selectedWorkspace,
    globalStatus: {
      activeProjectCount: 0,
      activeTurnCount: 0,
      pendingApprovalCount: 0,
      failedCheckCount: 0,
      staleSessionCount: 0,
      unsafeStateCount: 0,
      providerIssues: [],
      ...globalStatus
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
      ...explanation
    },
    ...rest
  };
}

function setupProviderStatus(name: string, status: "available" | "unavailable"): ProviderStatusViewModel {
  return {
    providerId: "provider-setup" as ProviderStatusViewModel["providerId"],
    name,
    adapterVersion: "0.1.0",
    availability:
      status === "available"
        ? { status: "available", version: "1.0.0", details: setupProviderDetails("agentctl") }
        : { status: "unavailable", reason: "Provider command is not available.", details: setupProviderDetails("agentctl") },
    capabilities: {
      canStartSession: true,
      canResumeSession: false,
      canListSessions: false,
      canImportExistingSessions: false,
      canStreamEvents: true,
      canStreamTokenDeltas: false,
      canInterruptTurn: false,
      canSteerTurn: false,
      canRequestCommandApproval: true,
      canRequestFileApproval: false,
      canRunShellCommands: false,
      canEditFiles: false,
      canReportFileDiffs: false,
      canReportTokenUsage: false,
      canUseExternalTools: false,
      supportsSandboxing: false,
      supportsPermissionProfiles: false,
      supportsStructuredProtocol: true
    }
  };
}

function providerStatusWithId(
  providerId: string,
  name: string,
  status: "available" | "unavailable",
  patch: Partial<ProviderStatusViewModel["capabilities"]> = {}
): ProviderStatusViewModel {
  const provider = setupProviderStatus(name, status);
  return {
    ...provider,
    providerId: providerId as ProviderStatusViewModel["providerId"],
    capabilities: {
      ...provider.capabilities,
      ...patch
    }
  };
}

function setupProviderDetails(command: string): Record<string, unknown> {
  return {
    command,
    versionCommand: [command, "--version"],
    launchCommand: [command, "serve", "--stdio"],
    environmentOverrides: [{ name: "AGENTCTL_BIN", description: "Set before starting Praxis to override the provider binary." }],
    setupSteps: ["Install the provider command.", "Restart the local runtime.", "Run Check availability."],
    schemaStrategy: {
      typescriptCommand: [command, "generate-ts"],
      jsonSchemaCommand: [command, "generate-json-schema"]
    }
  };
}

function unavailableStartProviderDashboard(): DashboardProjection {
  const projectId = "project-unavailable-start" as ProjectCardViewModel["projectId"];
  const projectCard: ProjectCardViewModel = {
    projectId,
    title: "Unavailable start project",
    subtitle: "/workspace/unavailable-start",
    profileFacets: ["Project workspace", "operate", "local folder"],
    runtimeState: "idle",
    urgency: 0,
    stateLabel: "Idle",
    stateReason: "Ready to start project work.",
    providerLabel: "Unavailable runner",
    branchLabel: "main",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    failedCheckCount: 0,
    activeTurnCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    badges: [{ label: "Idle", tone: "idle" }],
    primaryAction: { id: "start-task", label: "Start task", method: "agents.startSession" },
    secondaryActions: [],
    diffFiles: [],
    evidence: []
  };
  return emptyDashboard({
    projectCards: [projectCard],
    home: { activeProjects: [projectCard] },
    providerStatus: [
      providerStatusWithId("provider-unavailable", "Unavailable runner", "unavailable", { canStartSession: true }),
      providerStatusWithId("provider-available", "Available runner", "available", { canStartSession: true })
    ]
  });
}

function noCheckWorkspaceDashboard(): DashboardProjection {
  const now = new Date(0).toISOString();
  const projectId = "project-no-checks" as ProjectCardViewModel["projectId"];
  const projectCard: ProjectCardViewModel = {
    projectId,
    title: "No-check Workspace",
    subtitle: "/workspace/no-checks",
    profileFacets: ["Project workspace", "research", "note"],
    runtimeState: "idle",
    urgency: 0,
    stateLabel: "Idle",
    stateReason: "No checks have been run yet.",
    providerLabel: "Fake provider",
    branchLabel: "main",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    failedCheckCount: 0,
    activeTurnCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    badges: [{ label: "Idle", tone: "idle" }],
    primaryAction: { id: "open-workspace", label: "Open workspace", method: "projects.getWorkspace" },
    secondaryActions: [],
    diffFiles: [],
    evidence: []
  };
  return emptyDashboard({
    focusedProjectId: projectId,
    projectCards: [projectCard],
    home: {
      activeProjects: [projectCard]
    },
    selectedWorkspace: {
      projectId,
      header: {
        name: "No-check Workspace",
        profileFacets: projectCard.profileFacets,
        state: "idle",
        activeWorkCount: 0,
        runningAgentCount: 0,
        pendingDecisionCount: 0,
        primaryAction: { id: "create-work-item", label: "Create work item", method: "workItems.create" }
      },
      workItems: {
        current: [],
        queued: [],
        blocked: [],
        completed: []
      },
      agentBoard: {
        queued: [],
        running: [],
        waiting: [],
        blocked: [],
        review: [],
        done: []
      },
      sources: [],
      artifacts: [],
      decisions: [],
      timeline: [
        {
          id: "no-check-event",
          kind: "system",
          eventType: "project.registered",
          projectId,
          title: "project.registered",
          summary: "Workspace created.",
          timestamp: now,
          status: "reported",
          evidence: [],
          expandable: false
        }
      ]
    } as NonNullable<DashboardProjection["selectedWorkspace"]>
  });
}

function workspaceLifecycleDashboard(): DashboardProjection {
  const dashboard = noCheckWorkspaceDashboard();
  const workspace = dashboard.selectedWorkspace!;
  const projectId = workspace.projectId;
  const now = new Date(0).toISOString();
  const source: ProjectSource & { usedByWorkItemIds: string[] } = {
    id: "source-action-1" as ProjectSource["id"],
    projectId,
    type: "note",
    title: "Interview notes",
    uriOrPath: "notes/interview.md",
    addedBy: "user",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    usedByWorkItemIds: ["work-action-1"]
  };
  const workItem: ProjectWorkItem = {
    id: "work-action-1" as ProjectWorkItem["id"],
    projectId,
    title: "Draft field guide",
    goal: "Turn source notes into a usable field guide.",
    workModes: ["write", "research"],
    status: "planned",
    priority: 2,
    sourceIds: [source.id],
    artifactIds: ["artifact-action-1" as ProjectWorkItem["artifactIds"][number]],
    createdAt: now,
    updatedAt: now,
    metadata: {}
  };
  const artifact: ProjectArtifact = {
    id: "artifact-action-1" as ProjectArtifact["id"],
    projectId,
    workItemId: workItem.id,
    agentRunId: "run-action-1" as ProjectArtifact["agentRunId"],
    type: "report",
    title: "Field guide draft",
    summary: "Draft report ready for review.",
    status: "draft",
    sourceIds: [source.id],
    evidence: [],
    createdAt: now,
    updatedAt: now,
    metadata: {}
  };
  const run: AgentRunCardViewModel = {
    runId: "run-action-1" as AgentRunCardViewModel["runId"],
    projectId,
    workItemId: workItem.id,
    roleName: "Writer",
    rolePreset: "writer",
    providerLabel: "Fake provider",
    providerId: "fake" as AgentRunCardViewModel["providerId"],
    linkedWorkItemTitle: workItem.title,
    status: "running",
    lastEvent: "agent.run.started",
    pendingDecisionCount: 0,
    pendingInput: false,
    producedArtifactCount: 1,
    primaryAction: { id: "send-instruction", label: "Send instruction", method: "agentRuns.sendInstruction" },
    evidence: [],
    advanced: {
      sessionId: "session-action-1" as AgentRunCardViewModel["advanced"]["sessionId"],
      providerSessionExternalKind: "runtime session"
    }
  };
  return {
    ...dashboard,
    providerStatus: [setupProviderStatus("Fake provider", "available")],
    selectedWorkspace: {
      ...workspace,
      workItems: {
        current: [],
        queued: [workItem],
        blocked: [],
        completed: []
      },
      agentBoard: {
        ...workspace.agentBoard,
        running: [run]
      },
      sources: [source],
      artifacts: [artifact]
    }
  };
}

function importSessionsDashboard(): DashboardProjection {
  const projectId = "project-import-action" as ProjectCardViewModel["projectId"];
  const provider = setupProviderStatus("Import provider", "available");
  provider.capabilities.canImportExistingSessions = true;
  const projectCard: ProjectCardViewModel = {
    projectId,
    title: "Import action project",
    subtitle: "/workspace/import-action",
    profileFacets: ["Project workspace", "operate", "local folder"],
    runtimeState: "stale",
    urgency: 3,
    stateLabel: "Stale",
    stateReason: "Provider sessions can be imported for recovery.",
    providerLabel: "Import provider",
    branchLabel: "main",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    failedCheckCount: 0,
    activeTurnCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 1,
    badges: [{ label: "Stale", tone: "stale" }],
    primaryAction: { id: "open-workspace", label: "Open workspace", method: "projects.getWorkspace" },
    secondaryActions: [{ id: "import-sessions", label: "Import sessions", method: "agents.importSessions" }],
    diffFiles: [],
    evidence: []
  };
  return emptyDashboard({
    projectCards: [projectCard],
    home: { activeProjects: [projectCard] },
    providerStatus: [provider]
  });
}

function agentDetailsDashboard(): DashboardProjection {
  const dashboard = noCheckWorkspaceDashboard();
  const workspace = dashboard.selectedWorkspace!;
  const run: AgentRunCardViewModel = {
    runId: "run-finished" as AgentRunCardViewModel["runId"],
    projectId: workspace.projectId,
    workItemId: "work-finished" as AgentRunCardViewModel["workItemId"],
    roleName: "Reviewer",
    rolePreset: "reviewer",
    providerLabel: "Fake provider",
    providerId: "fake" as AgentRunCardViewModel["providerId"],
    linkedWorkItemTitle: "Review notes",
    status: "completed",
    lastEvent: "agent.run.completed",
    pendingDecisionCount: 0,
    pendingInput: false,
    producedArtifactCount: 1,
    primaryAction: { id: "open-agent-run", label: "Open details", method: "agentRuns.listByProject" },
    evidence: [],
    advanced: {
      sessionId: "session-finished" as AgentRunCardViewModel["advanced"]["sessionId"],
      providerSessionExternalKind: "runtime session"
    }
  };
  return {
    ...dashboard,
    selectedWorkspace: {
      ...workspace,
      agentBoard: {
        ...workspace.agentBoard,
        done: [run]
      }
    }
  };
}

function sessionActionDashboard(): DashboardProjection {
  const projectId = "project-session-action" as ProjectCardViewModel["projectId"];
  const projectCard: ProjectCardViewModel = {
    projectId,
    title: "Session action project",
    subtitle: "/workspace/session-action",
    profileFacets: ["Project workspace", "operate", "local folder"],
    runtimeState: "idle",
    urgency: 0,
    stateLabel: "Idle",
    stateReason: "Ready to start project work.",
    providerLabel: "Runnable provider",
    branchLabel: "main",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    failedCheckCount: 0,
    activeTurnCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    badges: [{ label: "Idle", tone: "idle" }],
    primaryAction: { id: "start-task", label: "Start task", method: "agents.startSession" },
    secondaryActions: [],
    diffFiles: [],
    evidence: []
  };
  return emptyDashboard({
    focusedProjectId: projectId,
    projectCards: [projectCard],
    home: { activeProjects: [projectCard] },
    providerStatus: [setupProviderStatus("Runnable provider", "available")]
  });
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
