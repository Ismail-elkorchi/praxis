import { describe, expect, it } from "vitest";
import { providerId } from "../src/core";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { apiMethods, PraxisApi } from "../src/app/PraxisApi";
import { defaultPermissionProfile, PolicyService } from "../src/policies/PolicyService";
import { redactSecrets } from "../src/observability/redaction";

describe("security, API, and provider-neutral surface", () => {
  it("does not expose provider-specific API method names", () => {
    expect(apiMethods.some((method) => /openai|anthropic|gemini|claude|codex/i.test(method))).toBe(false);
  });

  it("requires approval for unknown risk and keeps full access out of the default profile", () => {
    const policy = new PolicyService();

    expect(defaultPermissionProfile.commandPolicy).not.toBe("allow");
    expect(defaultPermissionProfile.fileWritePolicy).not.toBe("allow");
    expect(policy.requiresApproval({ risk: "unknown" })).toBe(true);
    expect(policy.riskSignalsForFile("/workspace/project", "../outside.txt")).toContain("writes_outside_workspace");
  });

  it("redacts secret-like values from logs", () => {
    expect(redactSecrets("API_KEY=abc123 sk-testsecret1234567890")).not.toContain("abc123");
    expect(redactSecrets("TOKEN=secret-value")).toContain("[REDACTED]");
  });

  it("returns capability errors for unsupported provider actions", async () => {
    const app = await createPraxisApp();
    app.fakeProvider.setScenario("happy_path");
    app.fakeProvider.setCapabilities({ canInterruptTurn: false });

    const api = new PraxisApi(app);
    const response = await api.handle({
      id: "1",
      method: "agents.interruptTurn",
      params: { providerId: providerId("fake"), sessionId: "session_missing", turnId: "turn_missing" }
    });

    expect("error" in response ? response.error.code : undefined).toBe("capability_unavailable");
  });
});
