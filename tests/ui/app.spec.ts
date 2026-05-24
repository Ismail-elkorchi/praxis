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

  await page.getByRole("button", { name: "Accept once" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Diff review" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept once" })).toHaveCount(0);
});

test("global UI avoids runtime-provider names", async ({ page }) => {
  await page.goto("/");
  const body = await page.locator("body").innerText();

  expect(body).not.toMatch(/OpenAI|Anthropic|Gemini|Claude|Codex/);
});
