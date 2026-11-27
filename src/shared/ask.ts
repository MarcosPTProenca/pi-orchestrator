import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// keep: pergunta operacional do worker ao orquestrador; não bloqueia a tarefa nem é decisão do usuário.
const ASK_FILE = "ask.json";
export const ASK_KINDS = ["operacional", "produto", "arquitetura", "escopo"] as const;
const MAX_ASKS_PER_TASK = 3;

export interface AskEntry {
  id: string;
  kind: string;
  question: string;
  context: string;
  asked_at: string;
}

export function readAsks(dir: string): AskEntry[] {
  const file = join(dir, ASK_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { asks?: unknown };
    return Array.isArray(parsed.asks) ? (parsed.asks as AskEntry[]) : [];
  } catch {
    return [];
  }
}

export function latestAsk(dir: string): AskEntry | null {
  const asks = readAsks(dir);
  return asks.length > 0 ? asks[asks.length - 1] : null;
}

// keep: contrato verificável; só dúvida operacional passa, o resto segue para orch_report com status blocked.
export function askRefusal(kind: string, previous: number): string | null {
  if (!(ASK_KINDS as readonly string[]).includes(kind))
    return `tipo de pergunta inválido: ${kind}. Use operacional, produto, arquitetura ou escopo.`;
  if (kind !== "operacional")
    return `pergunta do tipo ${kind} não é operacional: use orch_report com status blocked e question.`;
  if (previous >= MAX_ASKS_PER_TASK)
    return `limite de ${MAX_ASKS_PER_TASK} perguntas operacionais atingido: use orch_report com status blocked e question.`;
  return null;
}

const ORACLE_FILE = "oracle.json";

// keep: origem do parecer para auditoria: subagent, modelo, tool call e hash da saída real.
export interface OracleOrigin {
  agent: string;
  model: string | null;
  tool_call_id: string;
  output_sha256: string;
}

interface OracleFile {
  verdicts: Record<string, string>;
  origins: Record<string, OracleOrigin>;
}

function readOracleFile(dir: string): OracleFile {
  const file = join(dir, ORACLE_FILE);
  if (!existsSync(file)) return { verdicts: {}, origins: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OracleFile>;
    return {
      verdicts: parsed.verdicts && typeof parsed.verdicts === "object" ? parsed.verdicts : {},
      origins: parsed.origins && typeof parsed.origins === "object" ? parsed.origins : {},
    };
  } catch {
    return { verdicts: {}, origins: {} };
  }
}

export function oracleVerdictFor(dir: string, askId: string): string | null {
  const { verdicts } = readOracleFile(dir);
  return Object.hasOwn(verdicts, askId) ? verdicts[askId] : null;
}

// keep: uma consulta ao Oracle por pergunta; registrar de novo é recusado para não haver ciclo de consultas.
export function recordOracleVerdict(
  dir: string,
  askId: string,
  verdict: string,
  origin: OracleOrigin | null = null,
): boolean {
  const state = readOracleFile(dir);
  if (Object.hasOwn(state.verdicts, askId)) return false;
  state.verdicts[askId] = verdict;
  if (origin) state.origins[askId] = origin;
  const file = join(dir, ORACLE_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
  return true;
}

export function appendAsk(dir: string, entry: AskEntry): void {
  const file = join(dir, ASK_FILE);
  const asks = [...readAsks(dir), entry];
  writeFileSync(`${file}.tmp`, JSON.stringify({ asks }, null, 2));
  renameSync(`${file}.tmp`, file);
}
