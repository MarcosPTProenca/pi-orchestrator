import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerOrchestratorTools, type OrchestratorToolContext } from "../src/orchestrator/tools.ts";
import { makeHarness, type Harness } from "./fakes.ts";

const MODEL = "claude-bridge/claude-haiku-5-5";
const REPO = "https://github.com/exemplo/herdr";

type Exec = (id: string, raw: Record<string, unknown>) => unknown;

function toolsFor(h: Harness) {
  const tools = new Map<string, { execute: Exec }>();
  const pi = {
    registerTool(t: { name: string; execute: Exec }) {
      tools.set(t.name, t);
    },
  } as unknown as ExtensionAPI;
  const ctx: OrchestratorToolContext = {
    orch: h.orch,
    planStore: {} as never,
    eventSink: { sendMessage() {}, appendEntry() {} },
    dryRun: false,
    maxActive: 10,
    queue: {},
    assertWritable() {},
    chooseModel: (requested) => Promise.resolve({ model: requested ?? MODEL, reason: "teste" }),
    startTask: () => Promise.reject(new Error("não esperado nesta suíte")),
    launchReady: () => Promise.resolve(),
    scopeVerdict: () => Promise.resolve(""),
    askVerdict: () => "",
    usage: () => null,
  };
  registerOrchestratorTools(pi, ctx);
  return (name: string, raw: Record<string, unknown>): Promise<unknown> => {
    const t = tools.get(name);
    if (!t) throw new Error(`ferramenta ausente: ${name}`);
    return Promise.resolve().then(() => t.execute("e2e", raw));
  };
}

function withRepo(h: Harness): void {
  rmSync(join(h.project, ".git"), { recursive: true, force: true });
  writeFileSync(join(h.project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const sh = [
    "git init -q -b master",
    `git remote add origin ${REPO}.git`,
    "git add package.json",
    "git -c user.name=t -c user.email=t@t commit -qm init",
  ].join(" && ");
  execFileSync("bash", ["-c", sh], { cwd: h.project });
}

const implementation = (project: string, n: number) => ({
  project_path: project,
  role: `impl-${n}`,
  request: `Implemente a issue #${n}: painel de tarefas conforme o layout aprovado.`,
  objective: `Critérios da issue #${n} atendidos e PR aberto.`,
  mode: "direct-pr",
  source: `${REPO}/issues/${n}`,
  acceptance: [`Critério verificável da issue #${n}`, "npm test verde"],
});

test("delegação válida da #224 lança worker com ticket e Herdr", async () => {
  const h = makeHarness();
  withRepo(h);
  const call = toolsFor(h);
  await call("orch_delegate", { tasks: [implementation(h.project, 224)] });
  assert.equal(h.herdr.opsOf("createTab").length, 1);
  assert.equal(h.orch.list().length, 1);
});

test("escopo vago recusado antes do lançamento: sem pane, sem worktree, sem tarefa", async () => {
  const h = makeHarness();
  withRepo(h);
  const call = toolsFor(h);
  await assert.rejects(
    call("orch_delegate", {
      tasks: [
        {
          project_path: h.project,
          role: "vago",
          request: "Resolva as issues visuais.",
          objective: "Issues visuais resolvidas.",
          mode: "direct-pr",
        },
      ],
    }),
    /recusada antes do lançamento: .*source ausente.*seleção não resolvido/,
  );
  assert.equal(h.herdr.opsOf("createTab").length, 0);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 0);
  assert.equal(h.orch.list().length, 0);
});

test("lote com um item vago não lança nem o item válido", async () => {
  const h = makeHarness();
  withRepo(h);
  const call = toolsFor(h);
  const vago = { ...implementation(h.project, 225), source: undefined, request: "Resolva as issues visuais." };
  await assert.rejects(call("orch_delegate", { tasks: [implementation(h.project, 224), vago] }), /recusada/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
  assert.equal(h.orch.list().length, 0);
});

test("orch_send não troca a tarefa da #224 para outra issue, mas aceita orientação da própria", async () => {
  const h = makeHarness();
  withRepo(h);
  const call = toolsFor(h);
  await call("orch_delegate", { tasks: [implementation(h.project, 224)] });
  const taskId = h.orch.list()[0].task_id;
  const before = h.orch.get(taskId);
  const promptsBefore = h.herdr.opsOf("prompt").length;

  await assert.rejects(
    call("orch_send", { task_id: taskId, text: "Passe a trabalhar na #225 também." }),
    /troca de escopo recusada/,
  );
  await assert.rejects(call("orch_send", { task_id: taskId, text: "Inclua a issue #229 nesta entrega." }), /#229/);
  assert.equal(h.herdr.opsOf("prompt").length, promptsBefore, "nada chega ao painel");
  assert.equal(h.orch.get(taskId).status, before.status);
  assert.equal(h.orch.get(taskId).source, `${REPO}/issues/224`);

  await call("orch_send", { task_id: taskId, text: "Ajuste o contraste do painel da #224 antes do PR." });
  assert.equal(h.herdr.opsOf("prompt").length, promptsBefore + 1);
});

test("pesquisa com várias issues continua lançando e pode investigar por send", async () => {
  const h = makeHarness();
  withRepo(h);
  const call = toolsFor(h);
  await call("orch_delegate", {
    tasks: [
      {
        project_path: h.project,
        role: "pesquisa",
        request: "Investigar as issues #224, #225 e #226 e reportar dependências entre elas.",
        objective: "Relatório com dependências.",
        mode: "report",
      },
    ],
  });
  assert.equal(h.herdr.opsOf("createTab").length, 1);
  const taskId = h.orch.list()[0].task_id;
  await call("orch_send", { task_id: taskId, text: "Compare a #225 com a #224 e reporte a diferença." });
  assert.equal(h.herdr.opsOf("prompt").length, 1);
});
