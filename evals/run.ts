import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios, type Scenario, type Run, type Check } from "./scenarios.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED = "";
const args = process.argv.slice(2);
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const model = flagValue(args, "--model") ?? "openai-codex/gpt-6.1-sol";
const only = flagValue(args, "--only");

function makeFixtures(): Record<string, string> {
  const base = mkdtempSync(join(tmpdir(), "orch-eval-"));
  const out: Record<string, string> = { _base: base };
  for (const name of ["alpha", "beta", "norepo"]) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n\nProjeto ${name} do teste de avaliação.\n`);
    if (name !== "norepo") {
      writeFileSync(join(dir, "AGENTS.md"), `# Regras de ${name}\n- Commits em português.\n`);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@local", "add", "-A"], { cwd: dir });
      execFileSync(
        "git",
        ["-c", "user.name=eval", "-c", "user.email=eval@local", "commit", "-q", "-m", "chore: init"],
        { cwd: dir },
      );
    }
    out[name] = dir;
  }
  return out;
}

interface Event {
  type: string;
  message?: Record<string, unknown>;
}

export function parseStream(text: string): Run {
  const run: Run = {
    calls: [],
    results: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    finalText: "",
    models: new Set(),
  };
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    const m = e.message ?? {};
    if (e.type !== "message_end") continue;
    if (m.role === "assistant") {
      const u = (m.usage ?? {}) as Record<string, number>;
      run.usage.input += u.input ?? 0;
      run.usage.output += u.output ?? 0;
      run.usage.cacheRead += u.cacheRead ?? 0;
      run.usage.cacheWrite += u.cacheWrite ?? 0;
      run.usage.total += u.totalTokens ?? 0;
      if (typeof m.model === "string") run.models.add(`${m.provider}/${m.model}`);
      const content = (m.content ?? []) as Record<string, unknown>[];
      const texts = content.filter((c) => c.type === "text").map((c) => String(c.text ?? ""));
      if (texts.join("").trim()) run.finalText = texts.join("\n");
      for (const c of content) {
        if (c.type === "toolCall")
          run.calls.push({ name: String(c.name), args: (c.arguments ?? {}) as Record<string, unknown> });
      }
    }
    if (m.role === "toolResult") {
      const content = (m.content ?? []) as Record<string, unknown>[];
      const text = content.map((c) => String(c.text ?? "")).join("\n");
      run.results.push({ name: String(m.toolName ?? ""), isError: Boolean(m.isError), text });
    }
  }
  return run;
}

function runPi(prompt: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "--mode",
        "json",
        "--model",
        model,
        ...(EXCLUDED ? ["--exclude-tools", EXCLUDED] : []),
        "-e",
        join(ROOT, "src", "index.ts"),
        "-p",
        prompt,
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGTERM"), 480_000);
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function taskRecords(stateDir: string): {
  models: (string | null)[];
  modes: string[];
  briefs: string[];
  projects: string[];
  count: number;
} {
  const file = join(stateDir, "state.json");
  if (!existsSync(file)) return { models: [], modes: [], briefs: [], projects: [], count: 0 };
  const tasks = Object.values(JSON.parse(readFileSync(file, "utf8")).tasks) as Record<string, unknown>[];
  return {
    count: tasks.length,
    models: tasks.map((t) => (t.model as string | null) ?? null),
    modes: tasks.map((t) => String(readFileSync(String(t.brief_path), "utf8").match(/modo: ([a-z-]+)/)?.[1] ?? "?")),
    briefs: tasks.map((t) => readFileSync(String(t.brief_path), "utf8")),
    projects: tasks.map((t) => String(t.project_path)),
  };
}

async function main(): Promise<void> {
  const fx = makeFixtures();
  const selected = scenarios.filter((s) => !only || s.id === only);
  const report: Record<string, unknown>[] = [];
  let failedTotal = 0;
  for (const sc of selected) {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-eval-state-"));
    const prompt = sc.prompt(fx);
    const t0 = Date.now();
    const stream = await runPi(prompt, {
      ...process.env,
      PI_ORCH_DRY_RUN: "1",
      PI_ORCH_STATE_DIR: stateDir,
      HOME: process.env.HOME ?? homedir(),
    });
    const run = parseStream(stream);
    const tasks = taskRecords(stateDir);
    const checks: { name: string; ok: boolean; detail: string }[] = sc.checks.map((c: Check) => {
      const r = c(run, tasks);
      return { name: r.name, ok: r.ok, detail: r.detail };
    });
    const failed = checks.filter((c) => !c.ok);
    failedTotal += failed.length;
    const seconds = Math.round((Date.now() - t0) / 1000);
    console.log(`\n== ${sc.id} (${seconds}s) ${failed.length === 0 ? "PASSOU" : "FALHOU"}`);
    for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` :: ${c.detail}`}`);
    console.log(`  tools: ${run.calls.map((c) => c.name).join(" > ") || "(nenhuma)"}`);
    console.log(
      `  tokens orquestrador: total=${run.usage.total} entrada=${run.usage.input} saída=${run.usage.output} cacheLeitura=${run.usage.cacheRead} cacheEscrita=${run.usage.cacheWrite}`,
    );
    report.push({
      id: sc.id,
      passed: failed.length === 0,
      seconds,
      checks,
      tools: run.calls,
      usage: run.usage,
      tasks: { count: tasks.count, models: tasks.models, modes: tasks.modes },
      final: run.finalText.slice(0, 600),
    });
  }
  const outDir = join(homedir(), ".pi", "orchestrator", "evals");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, JSON.stringify({ model, scenarios: report }, null, 2));
  console.log(
    `\nResumo: ${report.filter((r) => r.passed).length}/${report.length} cenários passaram, ${failedTotal} checagens falharam.`,
  );
  console.log(`Relatório: ${outFile}`);
  process.exitCode = failedTotal === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
