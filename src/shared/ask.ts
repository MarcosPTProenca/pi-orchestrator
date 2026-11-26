import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Pergunta operacional do worker ao orquestrador: não bloqueia a tarefa e não é decisão do usuário.
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

// Contrato verificável: só dúvida operacional passa; o resto segue para orch_report com status blocked.
export function askRefusal(kind: string, previous: number): string | null {
  if (!(ASK_KINDS as readonly string[]).includes(kind))
    return `tipo de pergunta inválido: ${kind}. Use operacional, produto, arquitetura ou escopo.`;
  if (kind !== "operacional")
    return `pergunta do tipo ${kind} não é operacional: use orch_report com status blocked e question.`;
  if (previous >= MAX_ASKS_PER_TASK)
    return `limite de ${MAX_ASKS_PER_TASK} perguntas operacionais atingido: use orch_report com status blocked e question.`;
  return null;
}

export function appendAsk(dir: string, entry: AskEntry): void {
  const file = join(dir, ASK_FILE);
  const asks = [...readAsks(dir), entry];
  writeFileSync(`${file}.tmp`, JSON.stringify({ asks }, null, 2));
  renameSync(`${file}.tmp`, file);
}
