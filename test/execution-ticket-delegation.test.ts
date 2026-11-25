import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseExecutionTicket } from "../src/shared/execution-ticket.ts";
import { PHASE_FILE, TICKET_FILE } from "../src/shared/plan.ts";
import { makeHarness } from "./fakes.ts";
import workerExtension from "../src/worker/worker-ext.ts";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

function realProject(h: ReturnType<typeof makeHarness>): string {
  rmSync(join(h.project, ".git"), { recursive: true, force: true });
  writeFileSync(
    join(h.project, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc" } }),
  );
  const sh =
    "git init -q -b master && git add package.json && git -c user.name=t -c user.email=t@t commit -qm init && git rev-parse HEAD";
  return execFileSync("bash", ["-c", sh], { cwd: h.project, encoding: "utf8" }).trim();
}

const delegateInput = (project: string, overrides: Record<string, unknown> = {}) => ({
  project_path: project,
  role: "impl",
  request: "Corrigir o bug X",
  objective: "Bug X corrigido",
  mode: "direct-pr" as const,
  source: "https://github.com/acme/repo/issues/7",
  acceptance: ["Teste de regressão do bug X passa", "npm test verde"],
  ...overrides,
});

test("delegação com critérios grava ticket.json válido na pasta da tarefa", async () => {
  const h = makeHarness();
  const head = realProject(h);
  const t = await h.orch.delegate(delegateInput(h.project));
  const file = join(t.task_dir, TICKET_FILE);
  assert.ok(existsSync(file), "delegação real deve criar ticket.json");
  const ticket = parseExecutionTicket(JSON.parse(readFileSync(file, "utf8")));
  assert.equal(ticket.task_id, t.task_id);
  assert.equal(ticket.status, "ready");
  assert.equal(ticket.mode, "direct-pr");
  assert.equal(ticket.origin.base_sha, head);
  assert.equal(ticket.origin.source, "https://github.com/acme/repo/issues/7");
  assert.deepEqual(
    ticket.acceptance.map((a) => a.id),
    ["AC-1", "AC-2"],
  );
  assert.deepEqual(ticket.allowed_actions, ["create_branch", "commit", "push", "open_pr"]);
  assert.deepEqual(ticket.validation.commands, ["npm test", "npm run typecheck"]);
  assert.equal(ticket.artifacts.report_path, join(t.task_dir, "report.json"));
});

test("report com critérios não ganha permissão de publicação no ticket", async () => {
  const h = makeHarness();
  realProject(h);
  const t = await h.orch.delegate(delegateInput(h.project, { mode: "report" }));
  const ticket = parseExecutionTicket(JSON.parse(readFileSync(join(t.task_dir, TICKET_FILE), "utf8")));
  assert.deepEqual(ticket.allowed_actions, []);
  assert.deepEqual(ticket.authority, { execute_plan: false, integrate: false });
});

test("legado: delegação sem critérios continua sem ticket, como antes", async () => {
  const h = makeHarness();
  realProject(h);
  const { acceptance: _omit, ...input } = delegateInput(h.project);
  void _omit;
  const t = await h.orch.delegate(input);
  assert.equal(existsSync(join(t.task_dir, TICKET_FILE)), false);
});

test("critério vazio falha antes de criar a pasta da tarefa", async () => {
  const h = makeHarness();
  realProject(h);
  const before = readdirSync(h.stateDir).length;
  await assert.rejects(
    h.orch.delegate(delegateInput(h.project, { acceptance: ["ok", "  "] })),
    /acceptance\[1\] vazio/,
  );
  assert.equal(h.herdr.opsOf("createTab").length, 0, "nenhum worker deve ser lançado");
  assert.equal(readdirSync(h.stateDir).length, before);
});

test("projeto sem scripts oficiais falha na delegação, não no worker", async () => {
  const h = makeHarness();
  const head = realProject(h);
  assert.ok(head);
  writeFileSync(join(h.project, "package.json"), JSON.stringify({ name: "x" }));
  await assert.rejects(h.orch.delegate(delegateInput(h.project)), /validation sem comandos oficiais/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
});

test("worker consome o ticket gerado pela delegação real e exige plano", async () => {
  const h = makeHarness();
  realProject(h);
  const t = await h.orch.delegate(delegateInput(h.project));
  const prev = { ...process.env };
  const cwd = process.cwd();
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = t.task_id;
    process.env.PI_ORCH_TASK_DIR = t.task_dir;
    process.chdir(h.project);
    const handlers: Record<string, Handler> = {};
    workerExtension({
      on: (n: string, fn: Handler) => (handlers[n] = fn),
      registerTool() {},
      registerEntryRenderer() {},
      appendEntry() {},
    } as never);
    const out = (await handlers.before_agent_start(
      { systemPrompt: "base" },
      { sessionManager: { getEntries: () => [] } },
    )) as { systemPrompt: string };
    assert.match(out.systemPrompt, /orch_submit_plan/, "ticket válido ativa o protocolo de plano");
    const phase = JSON.parse(readFileSync(join(t.task_dir, PHASE_FILE), "utf8")) as { phase: string };
    assert.equal(phase.phase, "PREFLIGHT", "sem plano reutilizável o worker passa a PREFLIGHT");
  } finally {
    process.chdir(cwd);
    process.env = prev;
  }
});
