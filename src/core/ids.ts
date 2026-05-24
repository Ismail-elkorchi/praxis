export type Brand<TValue, TBrand extends string> = TValue & { readonly brand: TBrand };

export type ProjectId = Brand<string, "ProjectId">;
export type ProviderId = Brand<string, "ProviderId">;
export type AgentSessionId = Brand<string, "AgentSessionId">;
export type AgentTurnId = Brand<string, "AgentTurnId">;
export type ApprovalRequestId = Brand<string, "ApprovalRequestId">;
export type EventId = Brand<string, "EventId">;
export type CommandRunId = Brand<string, "CommandRunId">;
export type CheckRunId = Brand<string, "CheckRunId">;
export type CheckDefinitionId = Brand<string, "CheckDefinitionId">;
export type FileChangeId = Brand<string, "FileChangeId">;
export type PermissionProfileId = Brand<string, "PermissionProfileId">;

export function brandedId<TId extends Brand<string, string>>(prefix: string): TId {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` as TId;
}

export function projectId(): ProjectId {
  return brandedId<ProjectId>("project");
}

export function providerId(value: string): ProviderId {
  return value as ProviderId;
}

export function agentSessionId(): AgentSessionId {
  return brandedId<AgentSessionId>("session");
}

export function agentTurnId(): AgentTurnId {
  return brandedId<AgentTurnId>("turn");
}

export function approvalRequestId(): ApprovalRequestId {
  return brandedId<ApprovalRequestId>("approval");
}

export function eventId(): EventId {
  return brandedId<EventId>("event");
}

export function commandRunId(): CommandRunId {
  return brandedId<CommandRunId>("command");
}

export function checkRunId(): CheckRunId {
  return brandedId<CheckRunId>("check_run");
}

export function checkDefinitionId(): CheckDefinitionId {
  return brandedId<CheckDefinitionId>("check");
}

export function fileChangeId(): FileChangeId {
  return brandedId<FileChangeId>("file_change");
}
