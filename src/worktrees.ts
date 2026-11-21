import { homedir } from "node:os";

export interface Lease {
  path: string;
  holder: string;
}

export interface WorktreeOps {
  status(repo: string): string;
  git(path: string, args: string[]): string;
  returnTree(path: string): void;
}

export interface ReleaseNote {
  released: boolean;
  message: string;
}

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

export function releaseLease(ops: WorktreeOps, repo: string, holder: string, home: string = homedir()): ReleaseNote {
  let lease: Lease | undefined;
  try {
    lease = parseLeases(ops.status(repo), home).find((l) => l.holder === holder);
  } catch (err) {
    return {
      released: false,
      message: `não consegui listar o treehouse (${String(err).slice(0, 120)}); worktree não tocada`,
    };
  }
  if (!lease) return { released: false, message: "nenhuma worktree arrendada por esta tarefa" };
  const safe = safety(ops, lease.path);
  if (!safe.ok)
    return { released: false, message: `worktree mantida em ${lease.path}: ${safe.reason}. Nada foi apagado.` };
  try {
    ops.returnTree(lease.path);
    return { released: true, message: `worktree devolvida ao pool: ${lease.path}` };
  } catch (err) {
    return { released: false, message: `treehouse recusou devolver ${lease.path}: ${String(err).slice(0, 160)}` };
  }
}

export function orphanLeases(
  ops: WorktreeOps,
  repo: string,
  terminalHolders: Set<string>,
  home: string = homedir(),
): Lease[] {
  try {
    return parseLeases(ops.status(repo), home).filter((l) => terminalHolders.has(l.holder));
  } catch {
    return [];
  }
}
