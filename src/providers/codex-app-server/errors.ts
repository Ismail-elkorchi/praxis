import type { JsonRpcErrorPayload } from "./ProtocolTypes";

export class CodexJsonRpcError extends Error {
  constructor(readonly payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = "CodexJsonRpcError";
  }
}

export class CodexTransportError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CodexTransportError";
  }
}

export function codexErrorName(error: unknown): string {
  if (error instanceof CodexJsonRpcError) {
    const data = error.payload.data;
    if (data && typeof data === "object") {
      const candidate = "type" in data ? data.type : "name" in data ? data.name : undefined;
      if (typeof candidate === "string") return knownErrorName(candidate);
    }
    return knownErrorName(error.payload.message);
  }
  if (error instanceof Error) return knownErrorName(error.message);
  return "Other";
}

export function codexErrorMessage(error: unknown): string {
  if (error instanceof CodexJsonRpcError) return error.payload.message;
  if (error instanceof Error) return error.message;
  return "Provider request failed.";
}

export function isOverloadError(error: unknown): boolean {
  if (error instanceof CodexJsonRpcError) {
    if (error.payload.code === 429) return true;
    return codexErrorName(error) === "ResponseTooManyFailedAttempts";
  }
  return false;
}

function knownErrorName(value: string): string {
  const normalized = value.toLowerCase();
  const known = [
    "ContextWindowExceeded",
    "UsageLimitExceeded",
    "HttpConnectionFailed",
    "ResponseStreamConnectionFailed",
    "ResponseStreamDisconnected",
    "ResponseTooManyFailedAttempts",
    "BadRequest",
    "Unauthorized",
    "SandboxError",
    "InternalServerError"
  ];
  return known.find((name) => normalized.includes(name.toLowerCase())) ?? "Other";
}

