/**
 * Verificação determinística de uma tarefa concluída, separada do que o worker declarou.
 * Não usa LLM. Cada modo tem a sua regra; falha ao conferir vira "unverified", nunca "approved".
 */
import { prFromUrl } from "./prs.ts";

export type Verdict = "approved" | "rejected" | "not_applicable" | "unverified";
export interface Verification {
  verdict: Verdict;
  reason: string;
}

export interface VerifyEnv {
  /** Confere uma PR. ok=false com a linha de resumo quando não está pronta. Lança se não conseguir consultar. */
  prCheck(url: string): Promise<{ ok: boolean; line: string }>;
  /** Existe um commit com este SHA no repositório? Lança se não conseguir ler o repositório. */
  commitExists(sha: string): boolean;
  pathExists(path: string): boolean;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

export async function judgeDone(mode: string, status: string, artifacts: string[], env: VerifyEnv): Promise<Verification> {
  if (status !== "done") return { verdict: "not_applicable", reason: "tarefa não concluída pelo worker" };
  try {
    if (mode === "direct-pr") {
      const prs = artifacts.map(prFromUrl).filter((p): p is NonNullable<typeof p> => p !== null);
      if (prs.length === 0) return { verdict: "rejected", reason: "modo direct-pr sem PR em artefatos" };
      const lines: string[] = [];
      let rejected = false;
      for (const url of artifacts.filter((a) => prFromUrl(a))) {
        const r = await env.prCheck(url);
        lines.push(r.line);
        if (!r.ok) rejected = true;
      }
      return { verdict: rejected ? "rejected" : "approved", reason: lines.join(" ") };
    }
    // Legado: tarefas lançadas antes da remoção do modo local-only continuam verificáveis.
    if (mode === "local-only") {
      const shas = artifacts.flatMap((a) => a.match(SHA_RE) ?? []);
      if (shas.length === 0) return { verdict: "rejected", reason: "modo local-only sem commit informado em artefatos" };
      // Basta um SHA real: palavras hexadecimais em prosa não podem reprovar uma tarefa com commit válido.
      const found = shas.filter((s) => env.commitExists(s));
      if (found.length === 0) return { verdict: "rejected", reason: `nenhum commit encontrado no repositório entre: ${shas.join(", ")}` };
      return { verdict: "approved", reason: `commit(s) presentes no repositório: ${found.join(", ")}` };
    }
    if (mode === "report") {
      const files = artifacts.filter((a) => a.startsWith("/"));
      if (files.length === 0) return { verdict: "not_applicable", reason: "sem arquivo de artefato para conferir" };
      const gone = files.filter((f) => !env.pathExists(f));
      if (gone.length > 0) return { verdict: "rejected", reason: `artefato inexistente: ${gone.join(", ")}` };
      return { verdict: "approved", reason: "artefatos existem" };
    }
    return { verdict: "not_applicable", reason: `modo ${mode} sem verificação determinística` };
  } catch (err) {
    return { verdict: "unverified", reason: `não consegui conferir (${String(err).slice(0, 160)})` };
  }
}
