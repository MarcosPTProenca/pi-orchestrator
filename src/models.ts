/**
 * Modelos disponíveis no Pi, lidos de `pi --list-models`. Validação exata: um modelo pedido que
 * não existe vira erro explícito. Nunca há substituição silenciosa.
 */
import { execFileSync } from "node:child_process";

/** Interpreta a tabela de `pi --list-models` (colunas: provider, model, ...). */
export function parseModelTable(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || cols[0] === "provider") continue;
    out.push(`${cols[0]}/${cols[1]}`);
  }
  return out;
}

let cache: string[] | undefined;

export function availableModels(): string[] {
  if (!cache) cache = parseModelTable(execFileSync("pi", ["--list-models"], { encoding: "utf8", timeout: 60_000 }));
  return cache;
}

/** undefined = sem pedido (padrão do Pi). Modelo pedido precisa existir exatamente como provider/id. */
export function resolveModel(requested: string | undefined, available: string[]): string | undefined {
  if (requested === undefined || requested.trim() === "") return undefined;
  const id = requested.trim();
  if (available.includes(id)) return id;
  const sameProvider = available.filter((m) => m.startsWith(id.split("/")[0] + "/")).slice(0, 8);
  throw new Error(
    `modelo indisponível: "${id}". Nada foi lançado. Modelos disponíveis do mesmo provedor: ${sameProvider.join(", ") || "(nenhum)"}`,
  );
}
