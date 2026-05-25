const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgho_[A-Za-z0-9_]{8,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(token|api[_-]?key|password|secret|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi
];

export function redactCodexValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactCodexText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCodexValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sensitiveKey(key) ? "[REDACTED]" : redactCodexValue(nested)
      ])
    ) as T;
  }
  return value;
}

export function redactCodexText(value: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function sensitiveKey(key: string): boolean {
  return /token|api[_-]?key|password|secret|authorization|credential/i.test(key);
}

