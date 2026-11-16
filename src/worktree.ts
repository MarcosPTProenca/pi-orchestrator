/**
 * Worktrees isoladas via `treehouse` (pool de worktrees já usado no ambiente).
 * Trabalho de projeto nunca roda no checkout principal: o worker recebe uma worktree arrendada.
 */
import { execFile } from "node:child_process";

export interface WorktreePort {
  /** Arrenda uma worktree do pool para o repositório e devolve o caminho absoluto. */
  lease(repoPath: string, holder: string): Promise<string>;
}

/** Interpreta a saída de `treehouse get --lease`: caminho absoluto na última linha não vazia. */
export function parseLeasePath(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.at(-1);
  if (!last || !last.startsWith("/")) throw new Error(`treehouse não devolveu um caminho absoluto: ${stdout.trim()}`);
  return last;
}

export class TreehouseCli implements WorktreePort {
  private readonly bin: string;

  constructor(bin?: string) {
    this.bin = bin ?? process.env.TREEHOUSE_BIN ?? "treehouse";
  }

  lease(repoPath: string, holder: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ["get", "--lease", "--lease-holder", holder], { cwd: repoPath, timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`treehouse get --lease falhou: ${(stderr || err.message).trim()}`));
          return;
        }
        try {
          resolve(parseLeasePath(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
