import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("UI action wiring", () => {
  it("does not render API-labeled buttons without a handler or disabled state", async () => {
    const source = await readFile("src/ui/App.tsx", "utf8");
    const buttons = source.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
    const inert = buttons
      .filter((button) => button.includes("data-method="))
      .filter((button) => !button.includes("onClick=") && !button.includes("disabled"))
      .map((button) => button.replace(/\s+/g, " ").slice(0, 160));

    expect(inert).toEqual([]);
  });

  it("does not rely on optional action handlers for visible action buttons", async () => {
    const source = await readFile("src/ui/App.tsx", "utf8");

    expect(source).not.toContain("onAction?.");
    expect(source).not.toContain("onAction?:");
  });
});
