import type { PermissionProfileId, ProviderId } from "../core";

export type AppSettings = {
  databasePath: string;
  projectRoots: string[];
  enabledProviderIds: ProviderId[];
  defaultProviderId?: ProviderId;
  defaultPermissionProfileId: PermissionProfileId;
  telemetryMode: "off" | "local_only" | "opt_in_remote";
  rawProviderLogsEnabled: boolean;
};

export const defaultAppSettings: AppSettings = {
  databasePath: ".praxis/praxis.sqlite",
  projectRoots: [],
  enabledProviderIds: [],
  defaultPermissionProfileId: "permission_default" as PermissionProfileId,
  telemetryMode: "local_only",
  rawProviderLogsEnabled: false
};

export class SettingsService {
  private settings: AppSettings = { ...defaultAppSettings };

  get(): AppSettings {
    return { ...this.settings, enabledProviderIds: [...this.settings.enabledProviderIds], projectRoots: [...this.settings.projectRoots] };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    if (patch.rawProviderLogsEnabled && !this.settings.rawProviderLogsEnabled) {
      throw new Error("Raw provider logs require an explicit confirmation flow.");
    }
    this.settings = { ...this.settings, ...patch };
    return this.get();
  }
}
