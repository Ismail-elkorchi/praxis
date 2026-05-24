import type { CheckDefinition, DomainEvent, PermissionProfile, ProviderId } from "../core";
import type { AppEventLog } from "../events/AppEventLog";
import { createDomainEvent } from "../events/eventFactory";
import type { ProviderAdapter } from "../providers/interface";
import { validateProviderAdapterContract } from "../providers/interface";

export type PluginPermission =
  | "read_projects"
  | "read_events"
  | "contribute_ui"
  | "contribute_checks"
  | "contribute_risk_rules"
  | "contribute_provider_adapter";

export type PluginCommand = {
  method: string;
  params?: unknown;
};

export type DashboardPanelContribution = {
  id: string;
  title: string;
};

export type ProjectActionContribution = {
  id: string;
  label: string;
  command: PluginCommand;
};

export type RiskRuleContribution = {
  id: string;
  description: string;
  evaluate(input: unknown): { risk: PermissionProfile["maxRiskWithoutApproval"]; reason: string };
};

export type CheckDetectorContribution = {
  id: string;
  detect(rootPath: string): Promise<CheckDefinition[]>;
};

export type ProviderAdapterContribution = {
  id: ProviderId;
  adapter: ProviderAdapter;
};

export type DataViewContribution = {
  id: string;
  title: string;
};

export type Plugin = {
  id: string;
  name: string;
  permissions: PluginPermission[];
  contributes: {
    dashboardPanels?: DashboardPanelContribution[];
    projectActions?: ProjectActionContribution[];
    riskRules?: RiskRuleContribution[];
    checkDetectors?: CheckDetectorContribution[];
    providerAdapters?: ProviderAdapterContribution[];
    dataViews?: DataViewContribution[];
  };
};

export type EnabledPlugin = {
  plugin: Plugin;
  enabledAt: string;
};

export type InspectableRiskRule = {
  pluginId: string;
  pluginName: string;
  ruleId: string;
  description: string;
  permission: Extract<PluginPermission, "contribute_risk_rules">;
};

export class PluginRegistry {
  private readonly discovered = new Map<string, Plugin>();
  private readonly enabled = new Map<string, EnabledPlugin>();

  constructor(private readonly events: AppEventLog) {}

  discover(plugin: Plugin): void {
    validatePlugin(plugin);
    this.discovered.set(plugin.id, plugin);
  }

  listDiscovered(): Plugin[] {
    return [...this.discovered.values()];
  }

  listEnabled(): EnabledPlugin[] {
    return [...this.enabled.values()];
  }

  async enable(pluginId: string): Promise<void> {
    const plugin = this.discovered.get(pluginId);
    if (!plugin) {
      throw new Error("Plugin was not discovered.");
    }
    for (const contribution of plugin.contributes.providerAdapters ?? []) {
      await validateProviderAdapterContract(contribution.adapter, { expectedId: contribution.id });
    }
    this.enabled.set(pluginId, { plugin, enabledAt: new Date().toISOString() });
    await this.events.append(
      createDomainEvent({
        type: "plugin.enabled",
        source: "system",
        payload: { pluginId, name: plugin.name },
        evidence: []
      })
    );
  }

  async disable(pluginId: string): Promise<void> {
    this.enabled.delete(pluginId);
    await this.events.append(
      createDomainEvent({
        type: "plugin.disabled",
        source: "system",
        payload: { pluginId },
        evidence: []
      })
    );
  }

  contributions() {
    const plugins = this.listEnabled().map((entry) => entry.plugin);
    return {
      dashboardPanels: plugins.flatMap((plugin) => plugin.contributes.dashboardPanels ?? []),
      projectActions: plugins.flatMap((plugin) => plugin.contributes.projectActions ?? []),
      riskRules: plugins.flatMap((plugin) => plugin.contributes.riskRules ?? []),
      checkDetectors: plugins.flatMap((plugin) => plugin.contributes.checkDetectors ?? []),
      providerAdapters: plugins.flatMap((plugin) => plugin.contributes.providerAdapters ?? []),
      dataViews: plugins.flatMap((plugin) => plugin.contributes.dataViews ?? [])
    };
  }

  inspectableRiskRules(): InspectableRiskRule[] {
    return this.listEnabled().flatMap((entry) =>
      (entry.plugin.contributes.riskRules ?? []).map((rule) => ({
        pluginId: entry.plugin.id,
        pluginName: entry.plugin.name,
        ruleId: rule.id,
        description: rule.description,
        permission: "contribute_risk_rules" as const
      }))
    );
  }

  async emitActionCommand(pluginId: string, actionId: string): Promise<DomainEvent> {
    const plugin = this.enabled.get(pluginId)?.plugin;
    if (!plugin) {
      throw new Error("Plugin is not enabled.");
    }
    const action = plugin.contributes.projectActions?.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new Error("Plugin action was not found.");
    }
    return this.events.append(
      createDomainEvent({
        type: "plugin.command.emitted",
        source: "system",
        payload: { pluginId, actionId, command: action.command },
        evidence: []
      })
    );
  }
}

function validatePlugin(plugin: Plugin): void {
  if (!plugin.id || !plugin.name) {
    throw new Error("Plugin id and name are required.");
  }
  assertPermission(plugin, "contribute_ui", [
    ...(plugin.contributes.dashboardPanels ?? []),
    ...(plugin.contributes.projectActions ?? []),
    ...(plugin.contributes.dataViews ?? [])
  ]);
  assertPermission(plugin, "contribute_checks", plugin.contributes.checkDetectors ?? []);
  assertPermission(plugin, "contribute_risk_rules", plugin.contributes.riskRules ?? []);
  assertPermission(plugin, "contribute_provider_adapter", plugin.contributes.providerAdapters ?? []);
}

function assertPermission(plugin: Plugin, permission: PluginPermission, contributions: unknown[]): void {
  if (contributions.length > 0 && !plugin.permissions.includes(permission)) {
    throw new Error(`Plugin ${plugin.id} requires permission ${permission}.`);
  }
}
