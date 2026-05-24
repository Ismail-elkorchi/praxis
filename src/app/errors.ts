import type { EvidenceRef } from "../core";

export class PraxisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly evidence: EvidenceRef[] = []
  ) {
    super(message);
    this.name = "PraxisError";
  }
}

export function capabilityError(message: string, details: Record<string, unknown> = {}): PraxisError {
  return new PraxisError("capability_unavailable", message, details);
}

export function notFoundError(message: string, details: Record<string, unknown> = {}): PraxisError {
  return new PraxisError("not_found", message, details);
}
