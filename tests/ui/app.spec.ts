import { expect, test } from "@playwright/test";

test("dashboard shell uses provider-neutral language and keyboard focus", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Approval center" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept once" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText("Approvals");
  await expect(page.getByText("fake provider", { exact: false })).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("approval center can be resolved with keyboard", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Decline" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Diff review" }).first()).toBeVisible();
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

  const workspace = page.getByRole("region", { name: "Dashboard workspace" });
  const detailDrawer = page.getByRole("complementary", { name: "Details" });
  await expect(detailDrawer).toBeVisible();
  await expect(detailDrawer).toContainText("Selected project");

  const workspaceBox = await workspace.boundingBox();
  const drawerBox = await detailDrawer.boundingBox();
  expect(drawerBox?.y).toBeGreaterThan(workspaceBox?.y ?? 0);
});

test("global UI avoids runtime-provider names", async ({ page }) => {
  await page.goto("/");
  const body = await page.locator("body").innerText();

  expect(body).not.toMatch(/OpenAI|Anthropic|Gemini|Claude|Codex/);
});

test("activity timeline filters by event type", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "approval.requested" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "agent.turn.started" })).toBeVisible();

  await page.getByLabel("Filter by event type").selectOption("agent.turn.started");

  await expect(page.getByRole("heading", { name: "agent.turn.started" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "approval.requested" })).toHaveCount(0);
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

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Checks/ }).click();
  await expect(page.getByRole("region", { name: "Checks workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check runs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Active" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();

  const recentRuns = page.getByRole("region", { name: "Recent check runs" });
  await expect(recentRuns.getByText("npm test")).toBeVisible();
  await expect(recentRuns.getByText("Exit code")).toBeVisible();
  await expect(recentRuns.getByText("1.2 s")).toBeVisible();
  await expect(recentRuns.getByText("src/example.ts: expected value to pass")).toBeVisible();
  await expect(recentRuns.getByRole("link", { name: "src/example.ts" })).toHaveAttribute("data-method", "git.openDiff");
  await expect(page.getByRole("region", { name: "Active check runs" }).getByRole("button", { name: "Cancel" })).toHaveAttribute(
    "data-method",
    "checks.cancel"
  );
  await expect(page.getByRole("button", { name: "Run checks" })).toHaveAttribute("data-method", "checks.run");
});

test("provider status cards show capability and compatibility details", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.getByRole("region", { name: "Providers workspace" })).toBeVisible();

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
  await expect(fakeProvider.getByRole("button", { name: "Configure provider" })).toHaveAttribute("data-method", "providers.getStatus");

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
  await expect(settingsPanel.getByRole("region", { name: "Provider settings placement" })).toContainText("under Providers");
  await expect(settingsPanel.getByRole("button", { name: "Open provider status" })).toHaveAttribute("data-method", "providers.getStatus");
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
  await expect(page.getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-method", "events.query");
  await page.getByLabel("Search commands").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
});
