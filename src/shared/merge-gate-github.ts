import { execFile } from "node:child_process";
import type { ChangedFile } from "./merge-policy.ts";
import { ghEnvFor } from "./prs.ts";
import type { CheckRunFact, MergeGithub, MergeSnapshot, PrSnapshot, Protection, RepoFacts } from "./merge-gate.ts";

const PR_QUERY =
  "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number state isDraft body headRefName headRefOid baseRefName mergeable mergeStateStatus changedFiles autoMergeRequest{enabledAt} files(first:100){nodes{path changeType additions deletions}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion checkSuite{app{slug}}} ... on StatusContext{context state}}}}}}}}}}";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const KIND: Record<string, ChangedFile["kind"]> = {
  ADDED: "added",
  COPIED: "added",
  MODIFIED: "modified",
  CHANGED: "modified",
  DELETED: "deleted",
  RENAMED: "renamed",
};

const LINKED_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i;

export function parsePrSnapshot(json: unknown, repo: string): PrSnapshot | null {
  const pr = obj(obj(obj(obj(json).data).repository).pullRequest);
  if (typeof pr.number !== "number") return null;
  const headSha = str(pr.headRefOid);
  const commit = obj(obj(list(obj(pr.commits).nodes)[0]).commit);
  const rollup = str(commit.oid) === headSha ? list(obj(obj(commit.statusCheckRollup).contexts).nodes) : [];
  const checkRuns: CheckRunFact[] = rollup.map((raw) => {
    const c = obj(raw);
    if (c.__typename === "CheckRun") {
      return {
        name: str(c.name),
        app_slug: str(obj(obj(c.checkSuite).app).slug) || null,
        head_sha: headSha,
        status: str(c.status),
        conclusion: typeof c.conclusion === "string" ? c.conclusion : null,
      };
    }
    return {
      name: str(c.context),
      app_slug: null,
      head_sha: headSha,
      status: "COMPLETED",
      conclusion: str(c.state) || null,
    };
  });
  const files = list(obj(pr.files).nodes).map((raw) => {
    const f = obj(raw);
    return {
      path: str(f.path),
      kind: KIND[str(f.changeType)] ?? "modified",
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
    };
  });
  const linked = LINKED_ISSUE_RE.exec(str(pr.body));
  return {
    repo,
    number: pr.number,
    state: str(pr.state),
    is_draft: pr.isDraft === true,
    head_ref: str(pr.headRefName),
    head_sha: headSha,
    base_ref: str(pr.baseRefName),
    mergeable: str(pr.mergeable, "UNKNOWN"),
    merge_state_status: str(pr.mergeStateStatus, "UNKNOWN"),
    auto_merge_enabled: pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined,
    linked_issue: linked ? Number(linked[1]) : null,
    changed_files: Number(pr.changedFiles) || 0,
    files,
    check_runs: checkRuns,
  };
}

export function parseRepoFacts(json: unknown): RepoFacts {
  const r = obj(json);
  if (typeof r.allow_auto_merge !== "boolean") throw new Error("allow_auto_merge ausente na resposta do repositório");
  const branch = str(r.default_branch);
  if (branch === "") throw new Error("default_branch ausente na resposta do repositório");
  return { allow_auto_merge: r.allow_auto_merge, default_branch: branch };
}

export function parseProtection(json: unknown): Protection {
  const rs = obj(obj(json).required_status_checks);
  const fromChecks = list(rs.checks).map((c) => str(obj(c).context));
  const fromContexts = list(rs.contexts).map((c) => str(c));
  return { status: "protected", required_contexts: [...new Set([...fromChecks, ...fromContexts])].filter(Boolean) };
}

function gh(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function assertMergeArgs(args: string[]): void {
  const ok =
    args[0] === "pr" &&
    args[1] === "merge" &&
    args.includes("--auto") &&
    args.includes("--squash") &&
    args.includes("--match-head-commit") &&
    !args.includes("--admin");
  if (!ok)
    throw new Error("argumentos de merge fora da política (exige --auto --squash --match-head-commit, sem --admin)");
}

export function ghMergeGithub(remoteUrl: string, cwd: string): MergeGithub {
  const env = ghEnvFor(remoteUrl, process.env);
  return {
    async snapshot(repo: string, number: number): Promise<MergeSnapshot> {
      const [owner, name] = repo.split("/");
      const prRaw = await gh(
        [
          "api",
          "graphql",
          "-f",
          `query=${PR_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `n=${number}`,
        ],
        cwd,
        env,
      );
      const repoFacts = parseRepoFacts(JSON.parse(await gh(["api", `repos/${repo}`], cwd, env)));
      let protection: Protection;
      try {
        const raw = await gh(["api", `repos/${repo}/branches/${repoFacts.default_branch}/protection`], cwd, env);
        protection = parseProtection(JSON.parse(raw));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        protection = /Branch not protected/i.test(text)
          ? { status: "unprotected" }
          : { status: "unknown", error: text.slice(0, 200) };
      }
      return { pr: parsePrSnapshot(JSON.parse(prRaw), repo), repo: repoFacts, protection };
    },
    async merge(args: string[]): Promise<string> {
      assertMergeArgs(args);
      return gh(args, cwd, env);
    },
  };
}
