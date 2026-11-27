import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegateInput } from "./task.ts";

export interface RedPr {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  failing: string[];
  mergeable: string;
  mergeStateStatus: string;
}

export const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

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
      baseRefName: String(raw.baseRefName ?? ""),
      url: String(raw.url ?? ""),
      failing: [...new Set(failing)],
      mergeable: String(raw.mergeable ?? "UNKNOWN"),
      mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN"),
    });
  }
  return out;
}

export function ghEnvFor(remoteUrl: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!/MarcosPTProenca\/|github-pers[:/]/.test(remoteUrl)) return base;
  const file = join(homedir(), ".config", "rko-pr", "token");
  const token = readFileSync(file, "utf8").replace(/[\r\n]/g, "");
  return { ...base, GH_TOKEN: token };
}

export function repoFromRemote(remoteUrl: string): { owner: string; name: string } {
  const m = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`remote não reconhecido: ${remoteUrl.replace(/\/\/[^@]*@/, "//")}`);
  return { owner: m[1], name: m[2] };
}

export function parseGraphqlRedPrs(json: unknown): RedPr[] {
  const nodes = (json as { data?: { repository?: { pullRequests?: { nodes?: unknown[] } } } })?.data?.repository
    ?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw new Error("resposta do GraphQL sem pullRequests");
  const flat = nodes.map((raw) => {
    const pr = raw as Record<string, unknown>;
    const commit = (
      pr.commits as {
        nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: Record<string, unknown>[] } } } }[];
      }
    )?.nodes?.[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      headRefName: String(pr.headRefName ?? ""),
      baseRefName: String(pr.baseRefName ?? ""),
      url: String(pr.url ?? ""),
      mergeable: String(pr.mergeable ?? "UNKNOWN"),
      mergeStateStatus: String(pr.mergeStateStatus ?? "UNKNOWN"),
      statusCheckRollup: contexts.map((c) => ({ name: c.name ?? c.context, conclusion: c.conclusion, state: c.state })),
    };
  });
  return parseRedPrs(flat);
}

const PRS_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{number title url headRefName baseRefName mergeable mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}}}}}";

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

export function conflictNote(pr: RedPr): string {
  if (pr.mergeStateStatus !== "DIRTY" && pr.mergeable !== "CONFLICTING") return "";
  return ` ATENÇÃO: a PR está com conflito de merge contra a base ${pr.baseRefName} (mergeStateStatus ${pr.mergeStateStatus}). Resolva os conflitos antes de corrigir os checks, e confirme que a PR volta a ser mergeável.`;
}

export function fixInputFor(pr: RedPr, projectPath: string, model?: string): DelegateInput {
  return {
    project_path: projectPath,
    role: `fix-pr-${pr.number}`,
    request: [
      `Corrigir os checks vermelhos da PR #${pr.number} "${pr.title}" (branch ${pr.headRefName}).`,
      `Checks falhando: ${pr.failing.join(", ")}.`,
      `Fonte: ${pr.url}`,
    ].join("\n"),
    objective: `Os checks da PR #${pr.number} ficam verdes, com a causa corrigida no código.${conflictNote(pr)}`,
    mode: "direct-pr",
    constraints: [
      "Não atualize baselines, não desabilite testes nem lint para passar.",
      `Push somente na branch ${pr.headRefName}; não abra outro PR.`,
      ...(pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING"
        ? [
            `A PR tem conflito com a base ${pr.baseRefName}: resolva-o no próprio branch da PR (merge ou rebase da base) e não force-push na base.`,
          ]
        : []),
      "Use gh com a conta pessoal conforme a skill contas-credenciais: GH_TOKEN só no comando, sem trocar a conta global.",
      "Não feche PR e não faça merge.",
    ],
    source: pr.url,
    branch: pr.headRefName,
    model,
  };
}

export function prFromUrl(url: string): { owner: string; name: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

export interface PrState {
  number: number;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  headRefOid: string;
  checks: { name: string; conclusion: string | null; status: string | null; run_id?: number }[];
}

export function fetchPrState(
  remoteUrl: string,
  number: number,
  owner: string,
  name: string,
  cwd: string,
): Promise<PrState> {
  const env = ghEnvFor(remoteUrl, process.env);
  const q =
    "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number state mergeable mergeStateStatus headRefOid commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status checkSuite{databaseId}} ... on StatusContext{context state}}}}}}}}}}";
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${number}`],
      { cwd, env, timeout: 90_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`gh api graphql falhou: ${(stderr || err.message).trim()}`));
        try {
          const pr = (JSON.parse(stdout) as { data: { repository: { pullRequest: Record<string, unknown> } } }).data
            .repository.pullRequest;
          const commit = (
            pr.commits as {
              nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: Record<string, unknown>[] } } } }[];
            }
          )?.nodes?.[0]?.commit;
          const ctx = commit?.statusCheckRollup?.contexts?.nodes ?? [];
          resolve({
            number,
            state: String(pr.state),
            mergeable: String(pr.mergeable),
            mergeStateStatus: String(pr.mergeStateStatus),
            headRefOid: String(pr.headRefOid),
            checks: ctx.map((c) => ({
              name: String(c.name ?? c.context ?? "check"),
              conclusion: c.conclusion ? String(c.conclusion) : c.state ? String(c.state) : null,
              status: c.status ? String(c.status) : null,
              run_id:
                typeof (c.checkSuite as { databaseId?: unknown } | undefined)?.databaseId === "number"
                  ? (c.checkSuite as { databaseId: number }).databaseId
                  : undefined,
            })),
          });
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

export function prStateLine(s: PrState): string {
  const conflict = s.mergeStateStatus === "DIRTY" || s.mergeable === "CONFLICTING";
  return `Estado atual da PR #${s.number}: ${s.state}, mergeable ${s.mergeable}, mergeStateStatus ${s.mergeStateStatus}${conflict ? " — CONFLITO: não está pronta para merge." : "."}`;
}

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "SUCCESS".toLowerCase()]);

export function verifyPr(s: PrState): string[] {
  const problems: string[] = [];
  if (s.state === "MERGED") return [];
  if (s.state !== "OPEN") problems.push(`PR está ${s.state}, não aberta`);
  if (s.mergeable === "CONFLICTING" || s.mergeStateStatus === "DIRTY") problems.push("conflito de merge com a base");
  else if (s.mergeable !== "MERGEABLE") problems.push(`mergeable ${s.mergeable}`);
  if (s.checks.length === 0) problems.push("nenhum check reportado");
  for (const c of s.checks) {
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (c.status && c.status.toUpperCase() !== "COMPLETED") problems.push(`check "${c.name}" ainda ${c.status}`);
    else if (!GREEN.has(conclusion)) problems.push(`check "${c.name}" ${conclusion || "sem resultado"}`);
  }
  return problems;
}

export function verificationLine(s: PrState): string {
  if (s.state === "MERGED") return `Verificação da PR #${s.number}: VERIFICADA (já mesclada).`;
  const problems = verifyPr(s);
  const green = s.checks.filter((c) => GREEN.has((c.conclusion ?? "").toUpperCase())).length;
  if (problems.length === 0)
    return `Verificação da PR #${s.number}: VERIFICADA (${green}/${s.checks.length} checks verdes, mergeable, sem conflito).`;
  return `Verificação da PR #${s.number}: NÃO VERIFICADA. ${problems.join("; ")}.`;
}
