import type { CheckService } from "../checks/CheckService";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog } from "../events/AppEventLog";
import type { EventStore } from "../events/EventStore";
import type { GitService } from "../git/GitService";
import type { PolicyService } from "../policies/PolicyService";
import type { ProjectRegistryService } from "../projects/ProjectRegistryService";
import type { SettingsService } from "../settings/SettingsService";
import type { ProviderRegistry } from "./ProviderRegistry";
import type { ProviderService } from "./ProviderService";

export type PraxisRuntime = {
  events: AppEventLog;
  eventStore: EventStore;
  providerRegistry: ProviderRegistry;
  providers: ProviderService;
  projects: ProjectRegistryService;
  git: GitService;
  checks: CheckService;
  policies: PolicyService;
  settings: SettingsService;
  snapshot(): AppSnapshot;
  restore(): Promise<AppSnapshot>;
  replay(): Promise<AppSnapshot>;
};
