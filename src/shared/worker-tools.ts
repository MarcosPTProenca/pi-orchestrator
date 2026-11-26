import type { Mode } from "./intake.ts";

// keep: padrão restritivo; servidores MCP só entram por liberação explícita da tarefa (allowed_tools).
const BASE_TOOLS: Record<Mode, string[]> = {
  report: ["read", "bash", "grep", "find", "ls"],
  design: ["read", "bash", "grep", "find", "ls"],
  "direct-pr": ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const ORCH_TOOLS = ["orch_report", "orch_ask", "orch_mark_tdd", "orch_review_verdict", "orch_submit_plan"];

const RELEASE_RE = /^mcp__[A-Za-z0-9_-]+__(\*|[A-Za-z0-9_-]+)$/;

export const isToolRelease = (entry: string): boolean => RELEASE_RE.test(entry);

export function invalidToolRelease(entries: string[]): string | null {
  const bad = entries.find((e) => !isToolRelease(e));
  return bad === undefined
    ? null
    : `allowed_tools inválido: ${bad} (use mcp__<servidor>__* ou mcp__<servidor>__<ferramenta>)`;
}

export function workerToolSet(mode: Mode, releases: string[]): string[] {
  return [...new Set([...BASE_TOOLS[mode], ...ORCH_TOOLS, ...releases])];
}

// keep: --tools é lista de permissão; --no-mcp desliga os servidores só sem liberação, pois ele não aceita filtro.
export function workerToolArgs(mode: Mode, releases: string[]): string[] {
  const tools = workerToolSet(mode, releases).join(",");
  return releases.length === 0 ? ["--no-mcp", "--tools", tools] : ["--tools", tools];
}

export interface ToolPolicy {
  mode: Mode;
  allowed: string[];
}

function matches(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

// keep: a mensagem diz o motivo e o caminho de liberação; "tool not found" genérico não orienta o modelo.
export function toolCallBlockReason(toolName: string, policy: ToolPolicy): string | null {
  if (policy.allowed.some((p) => matches(toolName, p))) return null;
  return `ferramenta ${toolName} não liberada para o modo ${policy.mode}. Permitidas: ${policy.allowed.join(", ")}. Para liberar um servidor ou ferramenta, a tarefa deve pedir allowed_tools (ex.: mcp__plane__*).`;
}
