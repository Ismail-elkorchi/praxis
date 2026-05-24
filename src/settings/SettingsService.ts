import { guardedPermissionProfileId, type PermissionProfileId, type ProviderId } from "../core";

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
  defaultPermissionProfileId: guardedPermissionProfileId,
  telemetryMode: "local_only",
  rawProviderLogsEnabled: false
};

export type SettingsRepository = {
  readSetting<TValue>(key: string): TValue | undefined;
  writeSetting(key: string, value: unknown): void;
};

export type SettingsUpdateOptions = {
  confirmRawProviderLogs?: boolean;
};

const appSettingsKey = "app";

export class SettingsService {
  private settings: AppSettings;

  constructor(private readonly repository?: SettingsRepository) {
    const stored = repository?.readSetting<Partial<AppSettings>>(appSettingsKey);
    this.settings = normalizeSettings(stored);
    if (!stored) {
      this.repository?.writeSetting(appSettingsKey, this.settings);
    }
  }

  get(): AppSettings {
    return { ...this.settings, enabledProviderIds: [...this.settings.enabledProviderIds], projectRoots: [...this.settings.projectRoots] };
  }

  update(patch: Partial<AppSettings>, options: SettingsUpdateOptions = {}): AppSettings {
    if (patch.rawProviderLogsEnabled && !this.settings.rawProviderLogsEnabled && !options.confirmRawProviderLogs) {
      throw new Error("Raw provider logs require an explicit confirmation flow.");
    }
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.repository?.writeSetting(appSettingsKey, this.settings);
    return this.get();
  }
}

function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  return {
    ...defaultAppSettings,
    ...input,
    enabledProviderIds: [...(input?.enabledProviderIds ?? defaultAppSettings.enabledProviderIds)],
    projectRoots: [...(input?.projectRoots ?? defaultAppSettings.projectRoots)]
  };
}
