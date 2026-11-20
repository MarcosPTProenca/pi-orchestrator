/**
 * Arrendamentos do Treehouse (pool de worktrees git) ligados às tarefas do orquestrador.
 * Um worker arrenda a própria worktree com o id da tarefa como titular. Quando a tarefa é cancelada
 * ou perdida, a worktree só volta ao pool se não houver nada a perder: árvore limpa e HEAD já presente
 * em algum remoto. Nunca usa devolução forçada. Quando há trabalho, devolve só o aviso com caminho e motivo.
 */
import { homedir } from "node:os";

export interface Lease {
  path: string;
  holder: string;
}

export interface WorktreeOps {
  /** Saída textual de `treehouse status` no repositório. */
  status(repo: string): string;
  /** Saída de `git -C <path> <args>`. Lança se o git falhar. */
  git(path: string, args: string[]): string;
  /** `treehouse return <path>` sem --force. Lança se o treehouse recusar. */
  returnTree(path: string): void;
}

export interface ReleaseNote {
  released: boolean;
  message: string;
}

// treehouse >= 3 insere a branch "[x]" ou "(detached)" antes de "(held by …)".
const LEASE_RE = /(\S+)\s+leased\s+(\S+)(?:\s+(?:\[[^\]]*\]|\(detached\)))?\s+\(held by (\S+)\)/;

export function parseLeases(text: string, home: string = homedir()): Lease[] {
  const out: Lease[] = [];
  for (const line of text.split("\n")) {
    const m = LEASE_RE.exec(line);
    if (!m) continue;
    out.push({ holder: m[3], path: m[2].startsWith("~") ? home + m[2].slice(1) : m[2] });
  }
  return out;
}

/** Diz se a worktree pode voltar ao pool sem perder nada. Devolve o motivo quando não pode. */
function safety(ops: WorktreeOps, path: string): { ok: true } | { ok: false; reason: string } {
  let dirty = "";
  try {
    dirty = ops.git(path, ["status", "--porcelain"]).trim();
  } catch (err) {
    return { ok: false, reason: `não consegui ler o estado do git (${String(err).slice(0, 120)})` };
  }
  if (dirty !== "") return { ok: false, reason: "tem alterações não commitadas" };
  const remotes = ops.git(path, ["branch", "-r", "--contains", "HEAD"]).trim();
  if (remotes === "") return { ok: false, reason: "tem commit sem push (o HEAD não existe em nenhum remoto)" };
  return { ok: true };
}

/** Devolve ao pool a worktree arrendada pela tarefa, se for seguro. Nunca lança. */
export function releaseLease(ops: WorktreeOps, repo: string, holder: string, home: string = homedir()): ReleaseNote {
  let lease: Lease | undefined;
  try {
    lease = parseLeases(ops.status(repo), home).find((l) => l.holder === holder);
  } catch (err) {
    return { released: false, message: `não consegui listar o treehouse (${String(err).slice(0, 120)}); worktree não tocada` };
  }
  if (!lease) return { released: false, message: "nenhuma worktree arrendada por esta tarefa" };
  const safe = safety(ops, lease.path);
  if (!safe.ok) return { released: false, message: `worktree mantida em ${lease.path}: ${safe.reason}. Nada foi apagado.` };
  try {
    ops.returnTree(lease.path);
    return { released: true, message: `worktree devolvida ao pool: ${lease.path}` };
  } catch (err) {
    return { released: false, message: `treehouse recusou devolver ${lease.path}: ${String(err).slice(0, 160)}` };
  }
}

/** Arrendamentos de tarefas que já não estão ativas. Só leitura: o orquestrador lista, não devolve sozinho. */
export function orphanLeases(ops: WorktreeOps, repo: string, terminalHolders: Set<string>, home: string = homedir()): Lease[] {
  try {
    return parseLeases(ops.status(repo), home).filter((l) => terminalHolders.has(l.holder));
  } catch {
    return [];
  }
}
