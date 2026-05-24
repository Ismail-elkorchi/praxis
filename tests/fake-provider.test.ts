import { describe, expect, it } from "vitest";
import { projectId } from "../src/core";
import { FakeProviderAdapter } from "../src/providers/fake/FakeProviderAdapter";

describe("FakeProviderAdapter", () => {
  it("reports availability and starts a provider-neutral session", async () => {
    const adapter = new FakeProviderAdapter();

    await expect(adapter.checkAvailability()).resolves.toMatchObject({ status: "available" });

    const result = await adapter.startSession({
      projectId: projectId(),
      cwd: process.cwd(),
      goal: "Inspect project state"
    });

    expect(result.sessionId).toBeDefined();
    expect(result.providerSessionRef?.providerId).toBe(adapter.id);
    expect(result.events.map((event) => event.type)).toEqual(["agent.session.started"]);
  });
});
