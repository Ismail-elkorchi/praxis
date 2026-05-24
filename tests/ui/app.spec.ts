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
  await expect(page.getByRole("button", { name: "Explain state" }).first()).toHaveAttribute("data-method", "dashboard.explainMode");
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
