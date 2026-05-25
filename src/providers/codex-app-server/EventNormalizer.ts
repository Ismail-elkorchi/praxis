import {
  commandRunId,
  fileChangeId,
  type AgentSessionId,
  type AgentTurnId,
  type CommandRun,
  type DomainEvent,
  type FileChange,
  type ProjectId,
  type ProviderId
} from "../../core";
import { createDomainEvent } from "../../events/eventFactory";
import type { JsonRpcNotification } from "./ProtocolTypes";
import { redactCodexValue } from "./redaction";

export type CodexNormalizationContext = {
  providerId: ProviderId;
  sessionId?: AgentSessionId;
  projectId?: ProjectId;
  turnId?: AgentTurnId;
  threadIdToSessionId(threadId: string): AgentSessionId | undefined;
  sessionIdToProjectId(sessionId: AgentSessionId): ProjectId | undefined;
  localTurnId(externalTurnId: string, sessionId?: AgentSessionId): AgentTurnId | undefined;
  commandRunIdFor(externalId: string): CommandRun["id"];
  fileChangeIdFor(externalId: string): FileChange["id"];
};

export class CodexEventNormalizer {
  private readonly commandRunIds = new Map<string, CommandRun["id"]>();
  private readonly fileChangeIds = new Map<string, FileChange["id"]>();

  normalize(notification: JsonRpcNotification, context: CodexNormalizationContext): DomainEvent[] {
    const scope = resolveScope(notification.params, context);
    const projectId = scope.projectId ?? context.projectId;
    const sessionId = scope.sessionId ?? context.sessionId;
    const turnId = scope.turnId ?? context.turnId;

    switch (notification.method) {
      case "thread/status/changed":
        return normalizeThreadStatus(notification, context, projectId, sessionId, turnId);
      case "thread/started":
        if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: "agent.session.resumed",
            projectId,
            sessionId,
            providerId: context.providerId,
            source: "provider",
            payload: { status: "started" },
            evidence: []
          })
        ];
      case "thread/closed":
      case "thread/archived":
        if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: "agent.session.stopped",
            projectId,
            sessionId,
            providerId: context.providerId,
            source: "provider",
            payload: { reason: notification.method.split("/").at(-1) },
            evidence: []
          })
        ];
      case "thread/unarchived":
        if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: "agent.session.resumed",
            projectId,
            sessionId,
            providerId: context.providerId,
            source: "provider",
            payload: { status: "unarchived" },
            evidence: []
          })
        ];
      case "turn/started":
        if (!projectId || !sessionId || !turnId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: "agent.turn.started",
            projectId,
            sessionId,
            turnId,
            providerId: context.providerId,
            source: "provider",
            payload: { inputSummary: textField(notification.params, "inputSummary") ?? "Agent turn" },
            evidence: []
          })
        ];
      case "turn/completed":
        if (!projectId || !sessionId || !turnId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: completedEventType(notification.params),
            projectId,
            sessionId,
            turnId,
            providerId: context.providerId,
            source: "provider",
            payload: { result: textField(notification.params, "result") ?? textField(notification.params, "reason") ?? "Turn completed." },
            evidence: []
          })
        ];
      case "turn/diff/updated":
        if (!projectId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return fileChangesFromDiff(notification, context, projectId, sessionId, turnId);
      case "turn/plan/updated":
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoningSummary/delta":
      case "item/reasoning/summary/delta":
      case "thread/tokenUsage/updated":
      case "serverRequest/resolved":
      case "mcpToolCall/updated":
      case "webSearch/updated":
      case "imageView/updated":
        if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
        return [
          createDomainEvent({
            type: "agent.turn.delta",
            projectId,
            sessionId,
            turnId,
            providerId: context.providerId,
            source: "provider",
            payload: { text: summarizeNeutral(notification.method, notification.params), kind: notification.method },
            evidence: []
          })
        ];
      case "item/started":
        return normalizeItemStarted(notification, context, projectId, sessionId, turnId);
      case "item/completed":
        return normalizeItemCompleted(notification, context, projectId, sessionId, turnId);
      case "command/output/delta":
      case "item/commandOutput/delta":
        return normalizeCommandOutput(notification, context, projectId, sessionId, turnId);
      default:
        return [rawEvent(notification, context, projectId, sessionId, turnId, "unknown_notification")];
    }
  }

  commandRunIdFor(externalId: string): CommandRun["id"] {
    const existing = this.commandRunIds.get(externalId);
    if (existing) return existing;
    const id = commandRunId();
    this.commandRunIds.set(externalId, id);
    return id;
  }

  fileChangeIdFor(externalId: string): FileChange["id"] {
    const existing = this.fileChangeIds.get(externalId);
    if (existing) return existing;
    const id = fileChangeId();
    this.fileChangeIds.set(externalId, id);
    return id;
  }
}

function normalizeThreadStatus(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId | undefined,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined
): DomainEvent[] {
  const status = textField(notification.params, "status")?.toLowerCase();
  if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
  if (status === "stale" || status === "disconnected") {
    return [
      createDomainEvent({
        type: "agent.session.stale",
        projectId,
        sessionId,
        turnId,
        providerId: context.providerId,
        source: "provider",
        payload: { reason: "Provider reported a stale or disconnected session." },
        evidence: []
      })
    ];
  }
  if (status === "closed" || status === "archived") {
    return [
      createDomainEvent({
        type: "agent.session.stopped",
        projectId,
        sessionId,
        providerId: context.providerId,
        source: "provider",
        payload: { reason: status },
        evidence: []
      })
    ];
  }
  return [
    createDomainEvent({
      type: "agent.session.resumed",
      projectId,
      sessionId,
      providerId: context.providerId,
      source: "provider",
      payload: { status: status ?? "changed" },
      evidence: []
    })
  ];
}

function normalizeItemStarted(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId | undefined,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined
): DomainEvent[] {
  if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
  const item = itemPayload(notification.params);
  const itemId = textField(item, "id") ?? `${notification.method}:${Date.now()}`;
  const itemType = textField(item, "type") ?? textField(item, "kind");
  if (itemType === "commandExecution") {
    const id = context.commandRunIdFor(itemId);
    return [
      createDomainEvent({
        type: "agent.command.started",
        projectId,
        sessionId,
        turnId,
        providerId: context.providerId,
        source: "provider",
        payload: {
          id,
          projectId,
          sessionId,
          turnId,
          command: commandFromItem(item),
          cwd: textField(item, "cwd") ?? ".",
          status: "running",
          startedAt: new Date().toISOString()
        },
        evidence: []
      })
    ];
  }
  if (itemType === "fileChange") {
    const id = context.fileChangeIdFor(itemId);
    return [
      createDomainEvent({
        type: "agent.fileChange.proposed",
        projectId,
        sessionId,
        turnId,
        providerId: context.providerId,
        source: "provider",
        payload: fileChangePayload(id, projectId, sessionId, turnId, item, "proposed"),
        evidence: []
      })
    ];
  }
  return [
    createDomainEvent({
      type: "agent.turn.delta",
      projectId,
      sessionId,
      turnId,
      providerId: context.providerId,
      source: "provider",
      payload: { text: summarizeNeutral("item/started", item), kind: itemType ?? "item" },
      evidence: []
    })
  ];
}

function normalizeItemCompleted(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId | undefined,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined
): DomainEvent[] {
  if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
  const item = itemPayload(notification.params);
  const itemId = textField(item, "id") ?? `${notification.method}:${Date.now()}`;
  const itemType = textField(item, "type") ?? textField(item, "kind");
  if (itemType === "commandExecution") {
    const id = context.commandRunIdFor(itemId);
    const failed = Boolean((item as { failed?: unknown }).failed) || textField(item, "status") === "failed";
    return [
      createDomainEvent({
        type: failed ? "agent.command.failed" : "agent.command.completed",
        projectId,
        sessionId,
        turnId,
        providerId: context.providerId,
        source: "provider",
        payload: {
          id,
          projectId,
          sessionId,
          turnId,
          command: commandFromItem(item),
          cwd: textField(item, "cwd") ?? ".",
          status: failed ? "failed" : "completed",
          exitCode: numberField(item, "exitCode") ?? (failed ? 1 : 0),
          stdoutRef: textField(item, "stdout"),
          stderrRef: textField(item, "stderr"),
          completedAt: new Date().toISOString()
        },
        evidence: []
      })
    ];
  }
  if (itemType === "fileChange") {
    const id = context.fileChangeIdFor(itemId);
    return [
      createDomainEvent({
        type: "agent.fileChange.applied",
        projectId,
        sessionId,
        turnId,
        providerId: context.providerId,
        source: "provider",
        payload: fileChangePayload(id, projectId, sessionId, turnId, item, "applied"),
        evidence: []
      })
    ];
  }
  return [
    createDomainEvent({
      type: "agent.turn.delta",
      projectId,
      sessionId,
      turnId,
      providerId: context.providerId,
      source: "provider",
      payload: { text: summarizeNeutral("item/completed", item), kind: itemType ?? "item" },
      evidence: []
    })
  ];
}

function normalizeCommandOutput(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId | undefined,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined
): DomainEvent[] {
  if (!projectId || !sessionId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_scope")];
  const params = objectPayload(notification.params);
  const itemId = textField(params, "itemId") ?? textField(params, "id");
  if (!itemId) return [rawEvent(notification, context, projectId, sessionId, turnId, "missing_command_item")];
  const id = context.commandRunIdFor(itemId);
  return [
    createDomainEvent({
      type: "agent.command.output",
      projectId,
      sessionId,
      turnId,
      providerId: context.providerId,
      source: "provider",
      payload: {
        id,
        projectId,
        sessionId,
        turnId,
        stdoutRef: textField(params, "stdout") ?? textField(params, "text"),
        stderrRef: textField(params, "stderr")
      },
      evidence: []
    })
  ];
}

function fileChangesFromDiff(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined
): DomainEvent[] {
  const params = objectPayload(notification.params);
  const files = Array.isArray((params as { files?: unknown }).files)
    ? ((params as { files: unknown[] }).files)
    : Array.isArray((params as { changes?: unknown }).changes)
      ? ((params as { changes: unknown[] }).changes)
      : [];
  return files.map((file, index) => {
    const item = objectPayload(file);
    const externalId = textField(item, "id") ?? `${textField(item, "path") ?? "file"}:${index}`;
    const id = context.fileChangeIdFor(externalId);
    const change = fileChangePayload(id, projectId, sessionId, turnId, item, "proposed");
    return createDomainEvent({
      type: "agent.fileChange.proposed",
      projectId,
      sessionId,
      turnId,
      providerId: context.providerId,
      source: "provider",
      payload: change,
      evidence: change.evidence
    });
  });
}

function fileChangePayload(
  id: FileChange["id"],
  projectId: ProjectId,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined,
  item: Record<string, unknown>,
  status: FileChange["status"]
): FileChange {
  return {
    id,
    projectId,
    sessionId,
    turnId,
    path: textField(item, "path") ?? textField(item, "file") ?? "unknown",
    changeKind: changeKind(textField(item, "changeKind") ?? textField(item, "kind")),
    status,
    diffRef: textField(item, "diff") ?? textField(item, "diffRef"),
    evidence: []
  };
}

function rawEvent(
  notification: JsonRpcNotification,
  context: CodexNormalizationContext,
  projectId: ProjectId | undefined,
  sessionId: AgentSessionId | undefined,
  turnId: AgentTurnId | undefined,
  normalizationFailure: string
): DomainEvent {
  return createDomainEvent({
    type: "provider.rawEvent",
    projectId,
    sessionId,
    turnId,
    providerId: context.providerId,
    source: "provider",
    payload: redactCodexValue({ normalizationFailure, method: notification.method, params: notification.params }),
    evidence: []
  });
}

function resolveScope(params: unknown, context: CodexNormalizationContext) {
  const payload = objectPayload(params);
  const threadId = textField(payload, "threadId") ?? textField(payload, "thread_id");
  const externalTurnId = textField(payload, "turnId") ?? textField(payload, "turn_id");
  const sessionId = threadId ? context.threadIdToSessionId(threadId) : undefined;
  const projectId = sessionId ? context.sessionIdToProjectId(sessionId) : undefined;
  const turnId = externalTurnId ? context.localTurnId(externalTurnId, sessionId) : undefined;
  return { projectId, sessionId, turnId };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function itemPayload(params: unknown): Record<string, unknown> {
  const payload = objectPayload(params);
  return objectPayload((payload as { item?: unknown }).item ?? payload);
}

function textField(value: unknown, key: string): string | undefined {
  const payload = objectPayload(value);
  const field = payload[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const payload = objectPayload(value);
  const field = payload[key];
  return typeof field === "number" ? field : undefined;
}

function commandFromItem(item: Record<string, unknown>): string[] {
  const command = (item as { command?: unknown }).command;
  if (Array.isArray(command)) return command.map(String);
  if (typeof command === "string") return [command];
  return [];
}

function completedEventType(params: unknown): "agent.turn.completed" | "agent.turn.failed" {
  const status = textField(params, "status")?.toLowerCase();
  return status === "failed" || status === "error" ? "agent.turn.failed" : "agent.turn.completed";
}

function changeKind(value: string | undefined): FileChange["changeKind"] {
  if (value === "created" || value === "modified" || value === "deleted" || value === "renamed") return value;
  return "modified";
}

function summarizeNeutral(method: string, params: unknown): string {
  const payload = objectPayload(params);
  const text = textField(payload, "text") ?? textField(payload, "delta") ?? textField(payload, "summary");
  if (text) return text;
  if (method.includes("tokenUsage")) return "Token usage updated.";
  if (method.includes("mcpToolCall")) return "External tool call updated.";
  if (method.includes("webSearch")) return "Web search updated.";
  if (method.includes("imageView")) return "Image view updated.";
  return `${method} updated.`;
}
