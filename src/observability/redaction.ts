const secretPatterns = [
  /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*["']?[^"'\s]+/gi,
  /\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*=\s*["']?[^"'\s]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g
];

export function redactSecrets(input: string): string {
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), input);
}
