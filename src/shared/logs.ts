const DEFAULT_LOG_LINES = 40;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 8000;

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|token|secret|password|senha)\s*[=:]\s*)\S+/gi,
];

export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, re) => acc.replace(re, (m, pre?: string) => (pre ? `${pre}[mascarado]` : "[mascarado]")),
    text,
  );
}

export function tailLog(text: string, max = MAX_LOG_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `…${text.slice(text.length - max + 1)}`, truncated: true };
}

export function clampLines(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LOG_LINES;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LOG_LINES);
}
