import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toExecutionTicket, type ExecutionTicket } from "../src/shared/execution-ticket.ts";
import { PHASE_FILE, ticketFingerprint, type ImplementationPlan } from "../src/shared/plan.ts";
import workerExtension from "../src/worker/worker-ext.ts";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
type Block = { block?: boolean; reason?: string } | undefined;

function loadWorker(): { handlers: Record<string, Handler>; tools: Record<string, Tool> } {
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  workerExtension({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerTool: (t: { name: string } & Tool) => {
      tools[t.name] = t;
    },
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  } as never);
  return { handlers, tools };
}

async function withWorkerTask(ticketJson: boolean, fn: (taskDir: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "gate-repo-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  const taskDir = mkdtempSync(join(tmpdir(), "gate-task-"));
  writeFileSync(join(taskDir, "brief.md"), "## Pedido\nCorrigir o bug X");
  const env = { ...process.env };
  const cwd = process.cwd();
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-gate";
    process.env.PI_ORCH_TASK_DIR = taskDir;
    process.chdir(root);
    if (ticketJson) {
      const t = toExecutionTicket(
        {
          project_path: root,
          role: "impl",
          request: "Corrigir o bug X",
          objective: "Bug X corrigido",
          mode: "direct-pr",
          acceptance: ["Teste de regressão do bug X passa", "npm test verde"],
        },
        {
          task_id: "t-gate",
          attempt_id: "a-1",
          report_path: join(taskDir, "report.json"),
          base_sha: "abc",
          validation: { schema_version: 1, commands: ["npm test"], exceptions: [] },
        },
      );
      writeFileSync(join(taskDir, "ticket.json"), JSON.stringify(t));
    }
    await fn(taskDir);
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(taskDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

const phaseOf = (taskDir: string): string | undefined =>
  (JSON.parse(readFileSync(join(taskDir, PHASE_FILE), "utf8")) as { phase?: string }).phase;

function planFor(taskDir: string): ImplementationPlan {
  const t = JSON.parse(readFileSync(join(taskDir, "ticket.json"), "utf8")) as ExecutionTicket;
  return {
    schema_version: 1,
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    ticket_fingerprint: ticketFingerprint(t),
    base_sha: "abc",
    head_sha: null,
    kind: "bug",
    problem: "X quebra no limite",
    diagnosis: [{ ref: "src/a.ts:1", note: "comparação estrita" }],
    approach: "Trocar < por <= em src/a.ts",
    rejected_alternatives: [{ option: "Reescrever", reason: "fora do escopo" }],
    reproduction: "teste no limite falha",
    test_seams: [],
    steps: [
      {
        id: "S1",
        action: "Teste de regressão",
        files: ["test/a.test.ts"],
        verifies: ["AC-1"],
        check: "node --test test/a.test.ts",
      },
      { id: "S2", action: "Trocar comparação", files: ["src/a.ts"], verifies: ["AC-1", "AC-2"], check: "npm test" },
    ],
    criteria: [
      { id: "AC-1", covered_by: ["S1", "S2"], evidence: "regressão verde" },
      { id: "AC-2", covered_by: ["S2"], evidence: "npm test exit 0" },
    ],
    expected_tests: ["regressão no limite"],
    risks: [],
    deviations: [],
    blockers: [],
  };
}

const edit = (name = "edit") => ({ toolName: name, input: {} });
const start = (w: ReturnType<typeof loadWorker>) =>
  w.handlers.before_agent_start({ systemPrompt: "base" }, { sessionManager: { getBranch: () => [] } });

test("edição é bloqueada antes do plano e liberada depois de PLAN_READY (ordem)", () =>
  withWorkerTask(true, async (taskDir) => {
    const w = loadWorker();
    start(w);
    const before = w.handlers.tool_call(edit()) as Block;
    assert.equal(before?.block, true, "editar antes do plano deve ser bloqueado");
    assert.match(before?.reason ?? "", /PREFLIGHT/);
    assert.equal(phaseOf(taskDir), "PREFLIGHT");

    const r = await w.tools.orch_submit_plan.execute("c1", { plan: planFor(taskDir) });
    assert.match(r.content[0].text, /aceito/);
    assert.equal(phaseOf(taskDir), "PLAN_READY");
    assert.equal(w.handlers.tool_call(edit("write")), undefined, "com plano pronto a escrita passa");
  }));

test("plano recusado mantém a fase e devolve o motivo para corrigir", () =>
  withWorkerTask(true, async (taskDir) => {
    const w = loadWorker();
    start(w);
    const bad = {
      ...planFor(taskDir),
      steps: [{ id: "S1", action: "x", files: [], verifies: ["AC-1"], check: "testar tudo" }],
    };
    const r = await w.tools.orch_submit_plan.execute("c2", { plan: bad });
    assert.match(r.content[0].text, /recusado/);
    assert.equal(phaseOf(taskDir), "PREFLIGHT");
    assert.ok(w.handlers.tool_call(edit()));
  }));

test("reload da mesma tarefa reutiliza o plano válido e libera a edição", () =>
  withWorkerTask(true, async (taskDir) => {
    const first = loadWorker();
    start(first);
    await first.tools.orch_submit_plan.execute("c3", { plan: planFor(taskDir) });

    const second = loadWorker();
    start(second);
    assert.equal(second.handlers.tool_call(edit()), undefined, "plano válido persistido é reutilizado");
    assert.equal(phaseOf(taskDir), "PLAN_READY");
  }));

test("sem ticket.json o gate fica inativo: workers atuais seguem como antes", () =>
  withWorkerTask(false, () => {
    const w = loadWorker();
    start(w);
    assert.equal(w.handlers.tool_call(edit()), undefined);
  }));

test("ticket malformado vira BLOCKED e bloqueia a edição", () =>
  withWorkerTask(false, (taskDir) => {
    writeFileSync(join(taskDir, "ticket.json"), "{não é json");
    const w = loadWorker();
    start(w);
    assert.equal(phaseOf(taskDir), "BLOCKED");
    assert.equal((w.handlers.tool_call(edit()) as Block)?.block, true);
  }));
