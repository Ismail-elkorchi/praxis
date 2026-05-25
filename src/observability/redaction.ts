const secretPatterns = [
  /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*["']?[^"'\s]+/gi,
  /\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*=\s*["']?[^"'\s]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g
];

export function redactSecrets(input: string): string {
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), input);
}

export function redactValue<T>(input: T): T {
  return redactUnknown(input) as T;
}

function redactUnknown(input: unknown): unknown {
  if (typeof input === "string") {
    return redactSecrets(input);
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactUnknown(item));
  }
  if (!input || typeof input !== "object") {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      isSecretLikeKey(key) ? "[REDACTED]" : redactUnknown(value)
    ])
  );
}

function isSecretLikeKey(key: string): boolean {
  return /token|api[-_]?key|secret|password/i.test(key);
}
