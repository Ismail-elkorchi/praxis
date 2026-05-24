import { describe, expect, it } from "vitest";
import { createPraxisApp } from "../src/composition/createPraxisApp";
import { providerId } from "../src/core";
import type { ProviderAdapter } from "../src/providers/interface";
import type { Plugin } from "../src/plugins/PluginRegistry";
import { FakeProviderAdapter, fakeProviderCapabilities } from "../src/providers/fake/FakeProviderAdapter";

describe("plugin registry", () => {
  it("emits commands for plugin actions instead of mutating core state directly", async () => {
    const app = await createPraxisApp();
    const plugin: Plugin = {
      id: "example-plugin",
      name: "Example plugin",
      permissions: ["contribute_ui"],
      contributes: {
        projectActions: [{ id: "run-checks", label: "Run checks", command: { method: "checks.run", params: { checkId: "check" } } }]
      }
    };

    app.plugins.discover(plugin);
    await app.plugins.enable(plugin.id);
    const event = await app.plugins.emitActionCommand(plugin.id, "run-checks");

    expect(event.type).toBe("plugin.command.emitted");
    expect(app.snapshot().events.some((candidate) => candidate.type === "plugin.command.emitted")).toBe(true);
  });

  it("removes contributions when disabled and exposes inspectable risk rules", async () => {
    const app = await createPraxisApp();
    const plugin: Plugin = {
      id: "risk-plugin",
      name: "Risk plugin",
      permissions: ["contribute_risk_rules"],
      contributes: {
        riskRules: [{ id: "network-risk", description: "Detects network use", evaluate: () => ({ risk: "high", reason: "network" }) }]
      }
    };

    app.plugins.discover(plugin);
    await app.plugins.enable(plugin.id);
    expect(app.plugins.contributions().riskRules).toHaveLength(1);
    await expect(app.observability.diagnostics()).resolves.toMatchObject({
      safetyInspector: {
        pluginRiskRules: [
          {
            pluginId: "risk-plugin",
            pluginName: "Risk plugin",
            ruleId: "network-risk",
            description: "Detects network use",
            permission: "contribute_risk_rules"
          }
        ]
      }
    });
    await app.plugins.disable(plugin.id);
    expect(app.plugins.contributions().riskRules).toHaveLength(0);
    expect((await app.observability.diagnostics()).safetyInspector.pluginRiskRules).toHaveLength(0);
  });

  it("validates provider adapter contribution permissions", async () => {
    const runtime = await createPraxisApp();
    const plugin: Plugin = {
      id: "provider-plugin",
      name: "Provider plugin",
      permissions: [],
      contributes: {
        providerAdapters: [{ id: providerId("plugin-fake"), adapter: new FakeProviderAdapter() }]
      }
    };

    expect(() => runtime.plugins.discover(plugin)).toThrow(/contribute_provider_adapter/);
  });

  it("runs provider adapter contract checks before enabling provider plugins", async () => {
    const runtime = await createPraxisApp();
    const validProviderPlugin: Plugin = {
      id: "valid-provider-plugin",
      name: "Valid provider plugin",
      permissions: ["contribute_provider_adapter"],
      contributes: {
        providerAdapters: [{ id: providerId("fake"), adapter: new FakeProviderAdapter() }]
      }
    };
    const invalidProviderPlugin: Plugin = {
      id: "invalid-provider-plugin",
      name: "Invalid provider plugin",
      permissions: ["contribute_provider_adapter"],
      contributes: {
        providerAdapters: [{ id: providerId("invalid-provider"), adapter: invalidProviderAdapter() }]
      }
    };

    runtime.plugins.discover(validProviderPlugin);
    runtime.plugins.discover(invalidProviderPlugin);

    await expect(runtime.plugins.enable(validProviderPlugin.id)).resolves.toBeUndefined();
    await expect(runtime.plugins.enable(invalidProviderPlugin.id)).rejects.toThrow(/interruptTurn is required/);
    expect(runtime.plugins.listEnabled().map((entry) => entry.plugin.id)).not.toContain(invalidProviderPlugin.id);
  });
});

function invalidProviderAdapter(): ProviderAdapter {
  return {
    id: providerId("invalid-provider"),
    kind: "test",
    displayName: "Invalid provider",
    adapterVersion: "0.1.0",
    async getCapabilities() {
      return { ...fakeProviderCapabilities, canResumeSession: false, canSteerTurn: false, canInterruptTurn: true };
    },
    async checkAvailability() {
      return { status: "available" as const, version: "0.1.0" };
    },
    async startSession() {
      return { events: [] };
    },
    async stopSession() {},
    async sendTurn() {
      return { events: [] };
    },
    async respondToApproval() {},
    async *watchEvents() {}
  };
}
