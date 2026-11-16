/**
 * PRs com checks vermelhos e o input de correção de cada uma. Mecânica (listar e montar),
 * sem julgamento de LLM: o worker é que decide como corrigir.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegateInput } from "./orchestrator.ts";

export interface RedPr {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  failing: string[];
}

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** Interpreta `gh pr list --json number,title,headRefName,url,statusCheckRollup`. Só PRs com ao menos um check falhando. */
export function parseRedPrs(json: unknown): RedPr[] {
  if (!Array.isArray(json)) throw new Error("resposta de gh pr list não é uma lista");
  const out: RedPr[] = [];
  for (const raw of json as Record<string, unknown>[]) {
    const rollup = Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as Record<string, unknown>[]) : [];
    const failing = rollup
      .filter((c) => FAILING.has(String(c.conclusion ?? c.state ?? "").toUpperCase()))
      .map((c) => String(c.name ?? c.context ?? "check"));
    if (failing.length === 0) continue;
    out.push({
      number: Number(raw.number),
      title: String(raw.title ?? ""),
      headRefName: String(raw.headRefName ?? ""),
      url: String(raw.url ?? ""),
      failing: [...new Set(failing)],
    });
  }
  return out;
}

/**
 * Credencial da conta pessoal: só para repositórios MarcosPTProenca/*. Entra em GH_TOKEN somente
 * no processo do comando, como manda a skill contas-credenciais. O conteúdo nunca é impresso.
 */
export function ghEnvFor(remoteUrl: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!/MarcosPTProenca\/|github-pers[:/]/.test(remoteUrl)) return base;
  const file = join(homedir(), ".config", "rko-pr", "token");
  const token = readFileSync(file, "utf8").replace(/[\r\n]/g, "");
  return { ...base, GH_TOKEN: token };
}

/** owner e nome a partir da URL do remote (https ou ssh, com alias de host como github-pers). */
export function repoFromRemote(remoteUrl: string): { owner: string; name: string } {
  const m = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`remote não reconhecido: ${remoteUrl.replace(/\/\/[^@]*@/, "//")}`);
  return { owner: m[1], name: m[2] };
}

/** Interpreta a resposta do GraphQL de PRs abertas com o último commit e seus checks. */
export function parseGraphqlRedPrs(json: unknown): RedPr[] {
  const nodes = (json as { data?: { repository?: { pullRequests?: { nodes?: unknown[] } } } })?.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw new Error("resposta do GraphQL sem pullRequests");
  const flat = nodes.map((raw) => {
    const pr = raw as Record<string, unknown>;
    const commit = (pr.commits as { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: Record<string, unknown>[] } } } }[] })?.nodes?.[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      headRefName: String(pr.headRefName ?? ""),
      url: String(pr.url ?? ""),
      statusCheckRollup: contexts.map((c) => ({ name: c.name ?? c.context, conclusion: c.conclusion, state: c.state })),
    };
  });
  return parseRedPrs(flat);
}

const PRS_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{number title url headRefName commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}}}}}";

/** PRs abertas com check vermelho do repositório, pela API GraphQL via `gh api` (o `gh pr list` falha nesta máquina). */
export function listRedPrs(repoPath: string, remoteUrl: string): Promise<RedPr[]> {
  const { owner, name } = repoFromRemote(remoteUrl);
  const env = ghEnvFor(remoteUrl, process.env);
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["api", "graphql", "-f", `query=${PRS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`],
      { cwd: repoPath, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gh api graphql falhou: ${(stderr || err.message).trim()}`));
          return;
        }
        try {
          resolve(parseGraphqlRedPrs(JSON.parse(stdout)));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/** Input de correção de uma PR: pedido e objetivo montados a partir dos dados da PR, modo direct-pr na branch dela. */
export function fixInputFor(pr: RedPr, projectPath: string, model?: string): DelegateInput {
  return {
    project_path: projectPath,
    role: `fix-pr-${pr.number}`,
    request: [
      `Corrigir os checks vermelhos da PR #${pr.number} "${pr.title}" (branch ${pr.headRefName}).`,
      `Checks falhando: ${pr.failing.join(", ")}.`,
      `Fonte: ${pr.url}`,
    ].join("\n"),
    objective: `Os checks da PR #${pr.number} ficam verdes, com a causa corrigida no código.`,
    mode: "direct-pr",
    constraints: [
      "Não atualize baselines, não desabilite testes nem lint para passar.",
      `Push somente na branch ${pr.headRefName}; não abra outro PR.`,
      "Use gh com a conta pessoal conforme a skill contas-credenciais: GH_TOKEN só no comando, sem trocar a conta global.",
      "Não feche PR e não faça merge.",
    ],
    source: pr.url,
    branch: pr.headRefName,
    model,
  };
}
