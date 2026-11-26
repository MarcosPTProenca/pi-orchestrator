import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets } from "./logs.ts";

// keep: cronologia append-only por tarefa; é leitura para o operador, não gera aviso nem entra no inbox.
export const HISTORY_FILE = "history.jsonl";
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const COMPACT_CHARS = 160;
const DETAIL_CHARS = 1200;

type HistoryParty = "worker" | "orquestrador";
type HistoryKind = "pergunta" | "resposta" | "mensagem" | "relatorio" | "entrega";

export interface HistoryInput {
  at: string;
  from: HistoryParty;
  to: HistoryParty;
  kind: HistoryKind;
  status: string;
  ref: string | null;
  text: string;
}

interface HistoryItem extends HistoryInput {
  seq: number;
  text_truncated: boolean;
}

export interface HistoryPage {
  total: number;
  items: HistoryItem[];
  next_offset: number | null;
}

export function appendHistory(taskDir: string, entry: HistoryInput): void {
  mkdirSync(taskDir, { recursive: true });
  const safe = { ...entry, text: maskSecrets(entry.text) };
  // keep: quebra antes e depois de cada registro isola uma linha truncada por queda; sem elas, o registro seguinte se perde junto.
  appendFileSync(join(taskDir, HISTORY_FILE), `\n${JSON.stringify(safe)}\n`);
}

// keep: queda no meio da gravação deixa linha truncada; ela é ignorada para a cronologia não ficar inacessível.
function readAll(taskDir: string): HistoryInput[] {
  const file = join(taskDir, HISTORY_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryInput];
      } catch {
        return [];
      }
    });
}

export function readHistory(taskDir: string, opts: { limit?: number; offset?: number; detail?: boolean }): HistoryPage {
  const all = readAll(taskDir);
  const limit = Math.min(Math.max(opts.limit ?? HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const max = opts.detail ? DETAIL_CHARS : COMPACT_CHARS;
  const slice = all.slice(offset, offset + limit);
  const items = slice.map((e, i) => {
    const truncated = e.text.length > max;
    return {
      ...e,
      seq: offset + i + 1,
      text: truncated ? `${e.text.slice(0, max - 1)}…` : e.text,
      text_truncated: truncated,
    };
  });
  const next = offset + limit < all.length ? offset + limit : null;
  return { total: all.length, items, next_offset: next };
}
