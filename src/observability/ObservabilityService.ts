import { performance } from "node:perf_hooks";
import type {
  ApprovalRequest,
  CheckRun,
  CommandRun,
  DomainEvent,
  EvidenceRef,
  PermissionProfile,
  Proposition
} from "../core";
import type { AppSnapshot } from "../dashboard/types";
import type { AppEventLog, EventIngestionObservation, ProjectionTimingObservation } from "../events/AppEventLog";
import { defaultPermissionProfile, type PolicyService } from "../policies/PolicyService";
import type { PluginRegistry } from "../plugins/PluginRegistry";
import type { SettingsService } from "../settings/SettingsService";
import { redactSecrets, redactValue } from "./redaction";

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export type ProviderLogEntry = {
  eventId: DomainEvent["id"];
  providerId?: DomainEvent["providerId"];
  level: LogLevel;
  message: string;
  timestamp: DomainEvent["timestamp"];
  raw: boolean;
  payload?: unknown;
};

export type EventLogEntry = {
  eventId: DomainEvent["id"];
  sequence?: number;
  type: DomainEvent["type"];
  projectId?: DomainEvent["projectId"];
  providerId?: DomainEvent["providerId"];
  sessionId?: DomainEvent["sessionId"];
  timestamp: DomainEvent["timestamp"];
  source: DomainEvent["source"];
  evidence: EvidenceRef[];
  payload: unknown;
};

export type ReplayHealth =
  | {
      status: "ok";
      checkedAt: string;
      durationMs: number;
      eventCount: number;
      differences: [];
    }
  | {
      status: "mismatch";
      checkedAt: string;
      durationMs: number;
      eventCount: number;
      differences: string[];
    }
  | {
      status: "failed";
      checkedAt: string;
      durationMs: number;
      eventCount: number;
      message: string;
    };

export type ObservabilityDiagnostics = {
  providerLog: ProviderLogEntry[];
  eventLog: EventLogEntry[];
  projectionInspector: {
    dashboardMode: AppSnapshot["dashboard"]["mode"];
    projectStates: { projectId: string; state: string; evidence: EvidenceRef[] }[];
    evidenceEventIds: string[];
  };
  propositionInspector: Record<Proposition["value"], Proposition[]>;
  safetyInspector: {
    permissionProfile: PermissionProfile;
    rawProviderLogsEnabled: boolean;
    pendingApprovals: {
      approvalId: ApprovalRequest["id"];
      risk: ApprovalRequest["risk"];
      riskSignals: ApprovalRequest["riskSignals"];
      requiresApproval: boolean;
    }[];
    pluginRiskRules: ReturnType<PluginRegistry["inspectableRiskRules"]>;
    policyOutputs: { subject: string; requiresApproval: boolean; reason: string }[];
  };
  metrics: {
    eventIngestion: EventIngestionObservation[];
    projectionTimings: ProjectionTimingObservation[];
    providerEventIngestionLatencyMs: SummaryStats;
    approvalWaitTimeMs: SummaryStats;
    agentTurnDurationMs: SummaryStats;
    commandDurationMs: SummaryStats;
    checkDurationMs: SummaryStats;
    apiLatencyMs: SummaryStats;
    staleSessionCount: number;
  };
  replay: ReplayHealth;
};

export type SummaryStats = {
  count: number;
  min: number;
  max: number;
  avg: number;
  latest: number;
};

type ApiLatencyObservation = {
  method: string;
  durationMs: number;
  ok: boolean;
  recordedAt: string;
};

export class ObservabilityService {
  private readonly apiLatency: ApiLatencyObservation[] = [];

  constructor(
    private readonly events: AppEventLog,
    private readonly settings: SettingsService,
    private readonly policies: PolicyService,
    private readonly plugins: PluginRegistry,
    private readonly getSnapshot: () => AppSnapshot
  ) {}

  recordApiRequest(input: { method: string; durationMs: number; ok: boolean }): void {
    this.apiLatency.push({
      method: input.method,
      durationMs: input.durationMs,
      ok: input.ok,
      recordedAt: new Date().toISOString()
    });
    trim(this.apiLatency, 500);
  }

  async diagnostics(): Promise<ObservabilityDiagnostics> {
    const snapshot = this.getSnapshot();
    const events = await this.events.queryEvents();
    const telemetry = this.events.telemetry();
    const replay = await this.checkReplayHealth();

    return {
      providerLog: providerLog(events, this.settings.get().rawProviderLogsEnabled),
      eventLog: eventLog(events),
      projectionInspector: projectionInspector(snapshot),
      propositionInspector: propositionInspector(snapshot.dashboard.explanation.propositions),
      safetyInspector: safetyInspector(snapshot, this.settings, this.policies, this.plugins),
      metrics: {
        eventIngestion: telemetry.eventIngestion,
        projectionTimings: telemetry.projectionTimings,
        providerEventIngestionLatencyMs: summarize(
          telemetry.eventIngestion
            .filter((entry) => Boolean(entry.providerId) || entry.source === "provider")
            .map((entry) => entry.ingestionLatencyMs)
        ),
        approvalWaitTimeMs: summarize(approvalWaitTimes(snapshot)),
        agentTurnDurationMs: summarize(turnDurations(snapshot)),
        commandDurationMs: summarize(commandDurations(snapshot)),
        checkDurationMs: summarize(checkDurations(snapshot)),
        apiLatencyMs: summarize(this.apiLatency.map((entry) => entry.durationMs)),
        staleSessionCount: snapshot.dashboard.globalStatus.staleSessionCount
      },
      replay
    };
  }

  async checkReplayHealth(): Promise<ReplayHealth> {
    const started = performance.now();
    const checkedAt = new Date().toISOString();
    const eventCount = (await this.events.queryEvents()).length;
    try {
      const replayed = await this.events.replay();
      const current = this.getSnapshot();
      const currentStable = stableStringify(current);
      const replayStable = stableStringify(replayed);
      const durationMs = performance.now() - started;
      if (currentStable === replayStable) {
        return { status: "ok", checkedAt, durationMs, eventCount, differences: [] };
      }
      return {
        status: "mismatch",
        checkedAt,
        durationMs,
        eventCount,
        differences: ["Live projection differs from event replay."]
      };
    } catch (error) {
      return {
        status: "failed",
        checkedAt,
        durationMs: performance.now() - started,
        eventCount,
        message: error instanceof Error ? error.message : "Replay failed."
      };
    }
  }
}

function providerLog(events: DomainEvent[], rawProviderLogsEnabled: boolean): ProviderLogEntry[] {
  return events
    .filter((event) => {
      if (event.type === "provider.rawEvent") return rawProviderLogsEnabled;
      return event.type.startsWith("provider.");
    })
    .map((event) => ({
      eventId: event.id,
      providerId: event.providerId,
      level: logLevelForEvent(event),
      message: redactSecrets(providerMessage(event)),
      timestamp: event.timestamp,
      raw: event.type === "provider.rawEvent",
      payload: redactValue(event.payload)
    }));
}

function eventLog(events: DomainEvent[]): EventLogEntry[] {
  return events
    .filter((event) => event.type !== "provider.rawEvent")
    .map((event) => ({
      eventId: event.id,
      sequence: event.sequence,
      type: event.type,
      projectId: event.projectId,
      providerId: event.providerId,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      source: event.source,
      evidence: event.evidence,
      payload: redactValue(event.payload)
    }));
}

function projectionInspector(snapshot: AppSnapshot): ObservabilityDiagnostics["projectionInspector"] {
  const projectStates = Object.values(snapshot.projects).map((project) => ({
    projectId: project.project.id,
    state: project.runtimeState,
    evidence: project.propositions.flatMap((proposition) => proposition.evidence)
  }));
  return {
    dashboardMode: snapshot.dashboard.mode,
    projectStates,
    evidenceEventIds: unique(
      snapshot.dashboard.explanation.evidence
        .filter((evidence): evidence is Extract<EvidenceRef, { type: "event" }> => evidence.type === "event")
        .map((evidence) => evidence.eventId)
    )
  };
}

function propositionInspector(propositions: Proposition[]): Record<Proposition["value"], Proposition[]> {
  return {
    true: propositions.filter((proposition) => proposition.value === "true"),
    false: propositions.filter((proposition) => proposition.value === "false"),
    unknown: propositions.filter((proposition) => proposition.value === "unknown"),
    stale: propositions.filter((proposition) => proposition.value === "stale")
  };
}

function safetyInspector(
  snapshot: AppSnapshot,
  settings: SettingsService,
  policies: PolicyService,
  plugins: PluginRegistry
): ObservabilityDiagnostics["safetyInspector"] {
  const permissionProfile = defaultPermissionProfile;
  const pendingApprovals = snapshot.approvals.pending.map((approval) => ({
    approvalId: approval.id,
    risk: approval.risk,
    riskSignals: approval.riskSignals,
    requiresApproval: policies.requiresApproval({ risk: approval.risk, profile: permissionProfile })
  }));
  return {
    permissionProfile,
    rawProviderLogsEnabled: settings.get().rawProviderLogsEnabled,
    pendingApprovals,
    pluginRiskRules: plugins.inspectableRiskRules(),
    policyOutputs: pendingApprovals.map((approval) => ({
      subject: approval.approvalId,
      requiresApproval: approval.requiresApproval,
      reason: approval.requiresApproval ? "Risk exceeds the configured permission profile." : "Risk is within the configured profile."
    }))
  };
}

function providerMessage(event: DomainEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  if (payload && typeof payload === "object" && "availability" in payload) {
    const availability = payload.availability;
    if (availability && typeof availability === "object" && "reason" in availability && typeof availability.reason === "string") {
      return availability.reason;
    }
  }
  return event.type;
}

function logLevelForEvent(event: DomainEvent): LogLevel {
  if (event.type === "provider.error" || event.type === "provider.incompatible") return "error";
  if (event.type === "provider.unavailable") return "warning";
  if (event.type === "provider.rawEvent") return "debug";
  return "info";
}

function approvalWaitTimes(snapshot: AppSnapshot): number[] {
  return [...snapshot.approvals.pending, ...snapshot.approvals.history]
    .map((approval) => {
      const end = approval.resolvedAt ?? new Date().toISOString();
      return durationMs(approval.createdAt, end);
    })
    .filter(isNumber);
}

function turnDurations(snapshot: AppSnapshot): number[] {
  return Object.values(snapshot.projects)
    .flatMap((project) => Object.values(project.turns))
    .map((turn) => durationMs(turn.startedAt, turn.completedAt))
    .filter(isNumber);
}

function commandDurations(snapshot: AppSnapshot): number[] {
  return Object.values(snapshot.projects)
    .flatMap((project) => project.commandRuns)
    .map((run: CommandRun) => durationMs(run.startedAt, run.completedAt))
    .filter(isNumber);
}

function checkDurations(snapshot: AppSnapshot): number[] {
  return Object.values(snapshot.projects)
    .flatMap((project) => project.checkRuns)
    .map((run: CheckRun) => durationMs(run.startedAt, run.completedAt))
    .filter(isNumber);
}

function durationMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const parsedStart = Date.parse(start);
  const parsedEnd = Date.parse(end);
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) return undefined;
  return Math.max(0, parsedEnd - parsedStart);
}

function summarize(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, latest: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: total / values.length,
    latest: values[values.length - 1] ?? 0
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trim<T>(items: T[], maxLength: number): void {
  if (items.length > maxLength) {
    items.splice(0, items.length - maxLength);
  }
}
