import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addNewUsage,
  entriesToMessages,
  newUsage,
  orchestratorUsage,
  summarizeTurns,
  type Usage,
  type UsageState,
} from "../src/usage.ts";

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(Object.assign(new Error(stderr.slice(0, 300) || `exit ${code}`), { code: code ?? -1, stderr }));
    });
  });
}
const keep = process.argv.includes("--keep");
const real = process.argv.includes("--real");
const realExtIdx = process.argv.indexOf("--real-ext");
const realExt = realExtIdx > 0 ? resolve(process.argv[realExtIdx + 1]) : null;
if (real && !realExt) throw new Error("--real exige --real-ext <caminho da extensão claude-bridge>");
const IDLE_MS = 10_000;
const jsonOutIdx = process.argv.indexOf("--json-out");
const jsonOut = jsonOutIdx > 0 ? resolve(process.argv[jsonOutIdx + 1]) : null;

function fakeLlm(): Server {
  let n = 0;
  return createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      const id = `chatcmpl-sim-${n}`;
      const sse = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
      const base = { id, object: "chat.completion.chunk", created: 0, model: "fake-model" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }),
      );
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 7,
            total_tokens: 127,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

interface AssistantRow {
  responseId?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  durationMs?: number;
  stopReason?: string;
  usage: Usage;
}

function readAssistants(file: string): AssistantRow[] {
  const rows: AssistantRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { type?: string; message?: Record<string, unknown> };
    const m = e.message as
      | {
          role?: string;
          responseId?: string;
          timestamp?: number;
          provider?: string;
          model?: string;
          durationMs?: number;
          stopReason?: string;
          usage?: Record<string, number>;
        }
      | undefined;
    if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
    const u = m.usage;
    rows.push({
      responseId: m.responseId,
      timestamp: m.timestamp,
      provider: m.provider,
      model: m.model,
      durationMs: m.durationMs,
      stopReason: m.stopReason,
      usage: {
        ...newUsage(),
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        totalTokens: u.totalTokens ?? 0,
      },
    });
  }
  return rows;
}

const sum = (rows: AssistantRow[]) =>
  rows.reduce(
    (t, r) => ({
      input: t.input + r.usage.input,
      output: t.output + r.usage.output,
      cacheRead: t.cacheRead + r.usage.cacheRead,
      cacheWrite: t.cacheWrite + r.usage.cacheWrite,
      totalTokens: t.totalTokens + r.usage.totalTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  );

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-orch-usage-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(sessionDir);
  mkdirSync(cwd);

  const server = fakeLlm();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const port = (server.address() as { port: number }).port;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fakellm: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "fake",
          models: [
            {
              id: "fake-model",
              contextWindow: 100000,
              maxTokens: 4000,
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );

  const pi = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const started = Date.now();
    const base = [
      "-ne",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-tools",
      "--offline",
      "--session-dir",
      sessionDir,
      ...(real
        ? ["-e", realExt as string, "--provider", "claude-bridge", "--model", "claude-haiku-5-5"]
        : ["--provider", "fakellm", "--model", "fake-model"]),
    ];
    try {
      await run("pi", [...base, ...args], {
        cwd,
        timeout: 180_000,
        env: { ...process.env, ...(real ? {} : { PI_CODING_AGENT_DIR: agentDir }), ...extraEnv },
      });
      return { exit: 0, ms: Date.now() - started };
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      return { exit: e.code ?? -1, ms: Date.now() - started, stderr: (e.stderr ?? "").slice(0, 300) };
    }
  };

  const steps: Record<string, unknown>[] = [];
  const log = async (label: string, args: string[], env: Record<string, string> = {}) =>
    steps.push({ step: label, ...(await pi(args, env)) });

  await log("A1 status (sessão nova)", ["-p", "status?"]);
  const fileA = readdirSync(sessionDir).find((f) => f.endsWith(".jsonl"));
  if (!fileA) throw new Error(`sessão A não foi criada: ${JSON.stringify(steps)}`);
  const pathA = join(sessionDir, fileA);

  await log("A2 continuação (processo novo)", ["--session", pathA, "-p", "continua"]);

  const [r1, r2] = await Promise.all([
    pi(["--session", pathA, "-p", "conclusão 1"]),
    pi(["--session", pathA, "-p", "conclusão 2"]),
  ]);
  steps.push({ step: "A3a rajada (concorrente)", ...r1 }, { step: "A3b rajada (concorrente)", ...r2 });

  await log("B1 fork de A", ["--fork", pathA, "-p", "ramo B"]);

  const forks = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl") && join(sessionDir, f) !== pathA);
  const newest = forks.sort((a, b) => statSync(join(sessionDir, b)).mtimeMs - statSync(join(sessionDir, a)).mtimeMs)[0];
  if (newest) await log("B2 reinício no fork", ["--session", join(sessionDir, newest), "-p", "após reinício"]);

  const files0 = () => readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const beforeIdle = new Set(files0());
  await log("D1 sessão ociosa: início", ["-p", "status?"]);
  const fileD = files0().find((f) => !beforeIdle.has(f));
  if (!fileD) throw new Error("sessão ociosa não foi criada");
  const pathD = join(sessionDir, fileD);
  const turnsBeforeIdle = readAssistants(pathD).length;
  await new Promise((ok) => setTimeout(ok, IDLE_MS));
  const turnsAfterIdle = readAssistants(pathD).length;
  await log("D2 retomada após ociosa", ["--session", pathD, "-p", "após ociosa"]);
  const idle = {
    kind: "sessão em disco sem processo Pi ativo",
    idle_ms: IDLE_MS,
    assistant_turns_before_idle: turnsBeforeIdle,
    turns_added_while_idle: turnsAfterIdle - turnsBeforeIdle,
    assistant_turns_after_resume: readAssistants(pathD).length,
  };

  const taskDir = join(root, "task");
  mkdirSync(taskDir);
  writeFileSync(join(taskDir, "brief.md"), "# Tarefa\nResponda com a palavra ok.\n");
  const workerExt = fileURLToPath(new URL("../src/worker-ext.ts", import.meta.url));
  const delegationRun = await pi(["-e", workerExt, "-p", "Execute a tarefa do brief."], {
    PI_ORCH_ROLE: "worker",
    PI_ORCH_TASK_ID: "t-baseline",
    PI_ORCH_TASK_DIR: taskDir,
  });
  steps.push({ step: "C1 delegação (worker)", ...delegationRun });
  const usageFile = join(taskDir, "usage.json");
  const workerUsage = existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, "utf8")) as UsageState) : null;
  const delegation = {
    usage_json_written: workerUsage !== null,
    ...summarizeTurns(workerUsage?.turns ?? []),
  };

  const orchStateDir = join(root, "orch-state");
  mkdirSync(orchStateDir);
  const orchExt = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const orchEnv = { PI_ORCH_DRY_RUN: "1", PI_ORCH_STATE_DIR: orchStateDir };
  const beforeOrch = new Set(files0());
  await log("E1 orquestrador: consulta", ["-e", orchExt, "-p", "status?"], orchEnv);
  const fileE = files0().find((f) => !beforeOrch.has(f));
  if (!fileE) throw new Error("sessão do orquestrador não foi criada");
  const pathE = join(sessionDir, fileE);
  await log("E2 orquestrador: continuação", ["-e", orchExt, "--session", pathE, "-p", "continua"], orchEnv);
  const orchEntries = readFileSync(pathE, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
  const orchestrator = orchestratorUsage(orchEntries);

  server.close();

  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const perFile = files.map((f) => ({ file: f, rows: readAssistants(join(sessionDir, f)) }));
  let state: UsageState = { total: newUsage(), counted: [], turns: [] };
  for (const pf of perFile) {
    const entries = readFileSync(join(sessionDir, pf.file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
    state = addNewUsage(state.total, entriesToMessages(entries), state.counted, state.turns ?? []);
  }
  const naive = perFile.flatMap((pf) => pf.rows);
  const uniq = new Map<string, AssistantRow>();
  for (const r of naive) uniq.set(r.responseId ?? `t:${r.timestamp}`, r);
  const result = {
    steps,
    sessions: perFile.map((pf) => ({ file: pf.file, assistantTurns: pf.rows.length })),
    assistantEntriesAcrossFiles: naive.length,
    uniqueResponses: uniq.size,
    naiveSum: sum(naive),
    deduped: {
      input: state.total.input,
      output: state.total.output,
      cacheRead: state.total.cacheRead,
      cacheWrite: state.total.cacheWrite,
      totalTokens: state.total.totalTokens,
    },
    groundTruthSum: sum([...uniq.values()]),
    cacheHitRatio: state.total.cacheRead / (state.total.input + state.total.cacheRead + state.total.cacheWrite),
    costFromProvider: state.total.costFromProvider,
    kind: real
      ? "real Pi processes + real provider (claude-bridge/claude-haiku-5-5)"
      : "real Pi processes + simulated LLM (local HTTP); not a provider call",
    turns: summarizeTurns(state.turns ?? []),
    idle,
    delegation,
    orchestrator,
  };
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (jsonOut) writeFileSync(jsonOut, text + "\n");
  if (keep) console.error(`sandbox mantido em ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
