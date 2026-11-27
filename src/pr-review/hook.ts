import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { READ_ONLY_TOOLS, ReviewCoordinator, type ReviewRequest, type ReviewRunInput } from "../shared/review.ts";
import { writeReviewResult, type PrRef } from "../shared/review-verdict.ts";
import { defaultStateDir } from "../shared/store.ts";

// Hook pr-review da Factory: versionado no repo e carregado por -e só nas sessões de worker.
// Dispara ao abrir PR (gh pr create) e ao atualizar (git push com PR aberta). O revisor roda headless,
// somente leitura, e o veredito é gravado fora do taskDir (ver shared/review-verdict.ts para o limite aceito).

const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;
const GH_PR_CREATE = /\bgh(?:-axi)?\s+pr\s+create\b/;
const GIT_PUSH = /\bgit\s+push\b/;
const DEFAULT_MODELS = ["kiro/auto", "openai-codex/gpt-6-luna", "claude-bridge/claude-haiku-5-5"];
const REVIEW_TIMEOUT_MS = 15 * 60_000;
const GH_TIMEOUT_MS = 120_000;

interface ToolResultLike {
  toolName: string;
  input: Record<string, unknown>;
  content: { type: string; text?: string }[];
  isError?: boolean;
}

export interface ReviewHookDeps {
  stateDir: string;
  gh(args: string[], cwd: string): Promise<string>;
  runner(input: ReviewRunInput & { cwd: string; models: string[] }): Promise<string>;
  log?(event: string, data: Record<string, unknown>): void;
}

export function reviewModels(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PI_ORCH_REVIEW_MODELS;
  if (!raw) return DEFAULT_MODELS;
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export function prRefFromUrl(url: string): PrRef {
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/);
  if (!m) throw new Error(`URL de PR não reconhecida (plataforma desconhecida): ${url}`);
  return { owner: m[1], name: m[2], number: Number(m[3]) };
}

export function prUrlsFromCreate(command: string, output: string): string[] {
  if (!GH_PR_CREATE.test(command)) return [];
  return [...new Set([...output.matchAll(PR_URL)].map((m) => m[0]))];
}

export function createReviewHook(deps: ReviewHookDeps) {
  // Dedup por url@head: um review por PR e SHA; push novo tem SHA novo e reabre o review.
  const started = new Set<string>();

  async function reviewPr(url: string, cwd: string, taskDir: string | undefined): Promise<void> {
    const pr = prRefFromUrl(url);
    const info = JSON.parse(
      await deps.gh(["pr", "view", url, "--json", "state,headRefOid,baseRefOid,title,body"], cwd),
    ) as { state: string; headRefOid: string; baseRefOid: string; title: string };
    if (info.state !== "OPEN") return;
    const key = `${url}@${info.headRefOid}`;
    if (started.has(key)) return;
    started.add(key);
    try {
      const diff = await deps.gh(["pr", "diff", url], cwd);
      const brief =
        taskDir && existsSync(join(taskDir, "brief.md")) ? readFileSync(join(taskDir, "brief.md"), "utf8") : "";
      const req: ReviewRequest = {
        repo: `${pr.owner}/${pr.name}`,
        pr_url: url,
        issue_url: "(não informado)",
        implementation_plan: `Título da PR: ${info.title}\n\n${brief}`,
        acceptance: [],
        base_sha: info.baseRefOid,
        head_sha: info.headRefOid,
        diff,
        ci_status: "(não consultado pelo hook)",
        prior_reviews: [],
        project_instructions: [],
      };
      const models = reviewModels(process.env);
      const coordinator = new ReviewCoordinator({
        runner: (input) => deps.runner({ ...input, cwd, models }),
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      const result = await coordinator.request(req);
      writeReviewResult(deps.stateDir, pr, result);
      deps.log?.("recorded", { url, head: info.headRefOid, verdict: result.verdict });
    } catch (err) {
      started.delete(key);
      throw err;
    }
  }

  return {
    async onToolResult(event: ToolResultLike, ctx: { cwd: string; taskDir?: string }): Promise<void> {
      if (event.toolName !== "bash" || event.isError) return;
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const output = event.content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");
      let urls: string[] = [];
      if (GH_PR_CREATE.test(command)) urls = prUrlsFromCreate(command, output);
      else if (GIT_PUSH.test(command)) {
        // Update: a PR aberta da branch atual, se houver (gh pr view sem argumento usa a branch atual).
        const current = await deps.gh(["pr", "view", "--json", "url"], ctx.cwd).catch(() => "");
        const url = current ? (JSON.parse(current) as { url?: string }).url : undefined;
        if (url) urls = [url];
      }
      await Promise.all(
        urls.map((url) =>
          reviewPr(url, ctx.cwd, ctx.taskDir).catch((err) =>
            deps.log?.("failed", { url, error: String(err instanceof Error ? err.message : err).slice(0, 300) }),
          ),
        ),
      );
    },
  };
}

function ghRun(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      err ? reject(new Error(`gh ${args[0]} ${args[1] ?? ""} falhou: ${err.message}`)) : resolve(out),
    );
  });
}

// keep: o prompt vai por stdin (pi -p lê stdin pipado) para não estourar o limite de argumento com diffs grandes.
// keep: PI_ORCH_ROLE=reviewer e --no-extensions impedem que a sessão do revisor dispare outro review.
function runPi(model: string, input: ReviewRunInput & { cwd: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "-p",
        "--no-session",
        "--no-extensions",
        "--no-context-files",
        "--tools",
        READ_ONLY_TOOLS.join(","),
        "--model",
        model,
      ],
      { cwd: input.cwd, env: { ...process.env, PI_ORCH_ROLE: "reviewer" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let errText = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (errText += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim() !== "") resolve(out);
      else reject(new Error(`${model} saiu com código ${code}: ${errText.slice(-300)}`));
    });
    child.stdin.end(input.prompt);
  });
}

async function runHeadlessReviewer(input: ReviewRunInput & { cwd: string; models: string[] }): Promise<string> {
  const failures: string[] = [];
  for (const model of input.models) {
    try {
      return await runPi(model, input);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`nenhum modelo concluiu o review:\n${failures.join("\n")}`);
}

export default function prReviewHook(pi: ExtensionAPI): void {
  if (process.env.PI_ORCH_ROLE !== "worker") return;
  const stateDir = defaultStateDir();
  const reviewsDir = join(stateDir, "reviews");
  const hook = createReviewHook({
    stateDir,
    gh: ghRun,
    runner: runHeadlessReviewer,
    log: (event, data) => {
      mkdirSync(reviewsDir, { recursive: true });
      appendFileSync(join(reviewsDir, "hook.log"), `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`);
    },
  });
  pi.on("tool_result", (event, ctx) => {
    void hook.onToolResult(event, {
      cwd: ctx.cwd,
      taskDir: process.env.PI_ORCH_TASK_DIR,
    });
  });
}
