import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface LocateCandidate {
  path: string;
  name: string;
  remote: string | null;
  matched: string[];
  score: number;
}

const DOC_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", "pyproject.toml"];

export function queryTerms(query: string): string[] {
  const norm = query.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return [...new Set(norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
}

function remoteOf(path: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function docText(path: string): string {
  return DOC_FILES.map((f) => join(path, f))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8").slice(0, 20_000))
    .join("\n")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function locateProject(query: string, root: string, limit = 8): LocateCandidate[] {
  const terms = queryTerms(query);
  if (terms.length === 0) throw new Error("consulta sem termos úteis (use ao menos uma palavra com 3 letras)");
  const out: LocateCandidate[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!statSync(path).isDirectory() || !existsSync(join(path, ".git"))) continue;
    const name = entry.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const docs = docText(path);
    const matched: string[] = [];
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) {
        matched.push(`nome:${t}`);
        score += 3;
      }
      const hits = docs.split(t).length - 1;
      if (hits > 0) {
        matched.push(`doc:${t}(${Math.min(hits, 20)})`);
        score += Math.min(hits, 20);
      }
    }
    if (score > 0) out.push({ path, name: entry, remote: remoteOf(path), matched, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
