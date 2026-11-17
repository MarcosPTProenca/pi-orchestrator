import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport, reportKey } from "../src/contract.ts";
import { parsePanes, parseTabCreate, parseWorkspaceCreate, parseWorkspaceIds } from "../src/herdr.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Store } from "../src/store.ts";
import { makeHarness, writeReport } from "./fakes.ts";

test("validateReport: blocked exige question e id de tarefa correto", () => {
  assert.throws(() => validateReport({ task_id: "t1", status: "blocked", result: "" }, "t1"), /exige question/);
  assert.throws(() => validateReport({ task_id: "t2", status: "done", result: "" }, "t1"), /outra tarefa/);
  assert.throws(() => validateReport({ task_id: "t1", status: "weird", result: "" }, "t1"), /status de relatório/);
  const r = validateReport({ task_id: "t1", status: "done", result: "ok", artifacts: ["/a.md"] }, "t1");
  assert.equal(r.status, "done");
  assert.deepEqual(r.artifacts, ["/a.md"]);
});

test("reportKey é estável para o mesmo conteúdo e muda com o conteúdo", () => {
  assert.equal(reportKey("abc"), reportKey("abc"));
  assert.notEqual(reportKey("abc"), reportKey("abd"));
});

test("parsers leem o formato real do Herdr 0.9.1 (capturado em execução)", () => {
  const ws = JSON.parse(
    '{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w16:p1","terminal_id":"term_66066a317ab33f","tab_id":"w16:t1","workspace_id":"w16"},"tab":{"label":"1","tab_id":"w16:t1","workspace_id":"w16"},"type":"workspace_created","workspace":{"active_tab_id":"w16:t1","label":"probe-proj","workspace_id":"w16"}}}',
  );
  assert.deepEqual(parseWorkspaceCreate(ws), {
    workspace_id: "w16",
    seeded_tab_id: "w16:t1",
    pane_id: "w16:p1",
    terminal_id: "term_66066a317ab33f",
  });
  const tab = JSON.parse(
    '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w16:p2","terminal_id":"term_66066a3186bfb10","tab_id":"w16:t2"},"tab":{"label":"probe-task","tab_id":"w16:t2","workspace_id":"w16"},"type":"tab_created"}}',
  );
  assert.deepEqual(parseTabCreate(tab), { tab_id: "w16:t2", pane_id: "w16:p2", terminal_id: "term_66066a3186bfb10" });
  assert.deepEqual(parseWorkspaceIds({ result: { workspaces: [{ workspace_id: "w15" }, { workspace_id: "w16" }] } }), ["w15", "w16"]);
  const snap = { result: { snapshot: { panes: [{ pane_id: "w15:p1", terminal_id: "term_1", cwd: "/x", agent: "pi", agent_status: "working" }] } } };
  assert.equal(parsePanes(snap)[0].agent, "pi");
  assert.throws(() => parseTabCreate({}), /sem tab/);
});

test("delegate cria workspace do projeto, tab da tarefa e inicia o worker na tab", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise o login", objective: "Analise o login", mode: "report" });
  assert.equal(t.status, "running");
  assert.equal(h.herdr.opsOf("createWorkspace").length, 1);
  const tabArgs = h.herdr.opsOf("createTab")[0].args as { workspaceId: string; cwd: string; env: Record<string, string> };
  assert.equal(tabArgs.cwd, h.project, "tab abre no checkout do projeto; o worker arrenda a worktree dele");
  assert.equal(tabArgs.env.PI_ORCH_ROLE, "worker");
  assert.equal(tabArgs.env.PI_ORCH_TASK_ID, t.task_id);
  assert.equal(t.tab_id.startsWith(`${t.workspace_id}:`), true);
  const run = h.herdr.opsOf("runInPane")[0].args as { paneId: string; command: string };
  assert.equal(run.paneId, t.pane_id);
  assert.match(run.command, /^pi -e \/fake\/worker-ext\.ts /);
  assert.match(run.command, /chame orch_report\.'?$/);
  assert.match(readFileSync(t.brief_path, "utf8"), /## Pedido do usuário/);
  assert.match(readFileSync(t.brief_path, "utf8"), /Analise o login/);
  assert.match(readFileSync(t.brief_path, "utf8"), /orch_report/);
  assert.equal(h.herdr.opsOf("prompt").length, 0, "brief vai como argumento inicial, não como prompt");
});

test("a tab seed fica como âncora do projeto: nenhuma tab é fechada ao criar tarefa", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  assert.equal(h.herdr.opsOf("closeTab").length, 0);
  assert.ok(h.herdr.workspaces.has(t.workspace_id));
  assert.ok(h.herdr.panesList.some((p) => p.pane_id.startsWith(`${t.workspace_id}:`)));
});

test("se o workspace do projeto sumiu, cria outro (estado não aponta para workspace fantasma)", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "1", objective: "1", mode: "report" });
  h.herdr.workspaces.delete(a.workspace_id);
  h.herdr.panesList = h.herdr.panesList.filter((p) => !p.pane_id.startsWith(`${a.workspace_id}:`));
  writeReport(a.task_dir, a.task_id, { status: "done", result: "ok" });
  await h.orch.reconcile();
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "2", objective: "2", mode: "report" });
  assert.notEqual(b.workspace_id, a.workspace_id);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 2);
});

test("várias tarefas ativas ao mesmo tempo são aceitas, cada uma com sua tab", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "um", objective: "um", mode: "report" });
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "dois", objective: "dois", mode: "report" });
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.notEqual(a.tab_id, b.tab_id);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 1);
});

test("delegate rejeita caminho relativo", async () => {
  const h = makeHarness();
  await assert.rejects(h.orch.delegate({ project_path: "relativo", role: "a", request: "x", objective: "x", mode: "report" }), /absoluto/);
});

test("falha ao iniciar o worker fecha só a tab da tarefa e marca failed", async () => {
  const h = makeHarness();
  h.herdr.failStart = true;
  await assert.rejects(h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" }), /falhou \(simulado\)/);
  const closes = h.herdr.opsOf("closeTab").map((o) => o.args);
  const failed = h.orch.list()[0];
  assert.equal(closes.at(-1), failed.tab_id);
  assert.equal(failed.status, "failed");
});

test("close recusa tab trocada (terminal_id diferente)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.panesList = h.herdr.panesList.map((p) => (p.pane_id === t.pane_id ? { ...p, terminal_id: "outro" } : p));
  const before = h.herdr.opsOf("closeTab").length;
  await assert.rejects(h.orch.close(t.task_id), /não corresponde/);
  assert.equal(h.herdr.opsOf("closeTab").length, before);
});

test("answer rejeita tarefa que não está bloqueada", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  await assert.rejects(h.orch.answer(t.task_id, "oi"), /não está bloqueada/);
});

test("brief manda o worker arrendar a própria worktree; o orquestrador não arrenda", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /treehouse get --lease --lease-holder t-/);
  assert.match(brief, new RegExp(`--lease-holder ${t.task_id}`));
  assert.match(brief, /pwd -P/, "verificação de isolamento no setup");
  assert.equal(h.herdr.opsOf("createTab")[0].args && (h.herdr.opsOf("createTab")[0].args as { cwd: string }).cwd, h.project);
});

test("delegate passa o modelo pedido ao pi e registra na tarefa", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report", model: "claude-bridge/claude-haiku-5-5" });
  const run = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.match(run, /--model claude-bridge\/claude-haiku-5-5/);
  assert.equal(t.model, "claude-bridge/claude-haiku-5-5");
});

test("delegate sem model não passa --model (padrão do Pi)", async () => {
  const h = makeHarness();
  await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const run = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.equal(run.includes("--model"), false);
});

test("delegate recusa project_path que não é raiz de repositório git (ex.: diretório pai)", async () => {
  const h = makeHarness();
  const parent = mkdtempSync(join(tmpdir(), "orch-parent-"));
  await assert.rejects(h.orch.delegate({ project_path: parent, role: "a", request: "x", objective: "x", mode: "report" }), /não é a raiz de um repositório git/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
});


test("cancel fecha só a tab da tarefa; outra tarefa e o workspace permanecem", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "y", objective: "y", mode: "report" });
  const c = await h.orch.cancel(a.task_id);
  assert.equal(c.status, "cancelled");
  assert.equal(h.herdr.opsOf("closeTab").at(-1)?.args, a.tab_id);
  assert.ok(!h.herdr.panesList.some((p) => p.pane_id === a.pane_id), "pane da tarefa cancelada fechado");
  assert.ok(h.herdr.panesList.some((p) => p.pane_id === b.pane_id), "pane da outra tarefa preservado");
  assert.equal(h.orch.get(b.task_id).status, "running");
  assert.ok(h.herdr.workspaces.has(a.workspace_id));
});

test("cancel recusa pane trocado (terminal_id diferente) sem fechar nada", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const closesBefore = h.herdr.opsOf("closeTab").length;
  h.herdr.panesList = h.herdr.panesList.map((p) => (p.pane_id === a.pane_id ? { ...p, terminal_id: "term_novo" } : p));
  await assert.rejects(h.orch.cancel(a.task_id), /não corresponde/);
  assert.equal(h.herdr.opsOf("closeTab").length, closesBefore);
  assert.equal(h.orch.get(a.task_id).status, "running");
});

test("reconcile: pane vivo mantém; pane sumido com relatório vira done; sem relatório vira lost", async () => {
  const h = makeHarness();
  const live = await h.orch.delegate({ project_path: h.project, role: "a", request: "1", objective: "1", mode: "report" });
  const gone = await h.orch.delegate({ project_path: h.project, role: "a", request: "2", objective: "2", mode: "report" });
  const lost = await h.orch.delegate({ project_path: h.project, role: "a", request: "3", objective: "3", mode: "report" });
  writeReport(gone.task_dir, gone.task_id, { status: "done", result: "salvo antes" });
  h.herdr.panesList = h.herdr.panesList.filter((p) => p.pane_id !== gone.pane_id && p.pane_id !== lost.pane_id);
  await h.orch.reconcile();
  assert.equal(h.orch.get(live.task_id).status, "running");
  assert.equal(h.orch.get(gone.task_id).status, "done");
  assert.equal(h.orch.get(gone.task_id).result, "salvo antes");
  assert.equal(h.orch.get(lost.task_id).status, "lost");
});

test("estado persiste entre instâncias do orquestrador (reinício)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const again = new Orchestrator({
    herdr: h.herdr,
    store: new Store(join(h.stateDir, "state.json")),
    tasksDir: join(h.stateDir, "tasks"),
    workerExtPath: "/x",
    now: () => h.clock.ms,
    newHex: () => "ffffffff",
    availableModels: () => ["claude-bridge/claude-haiku-5-5"],
    dryRun: false,
  });
  assert.equal(again.get(t.task_id).status, "running");
});

test("brief traz pedido literal, objetivo, fonte, restrições, critérios e especificação quando dada", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project, role: "fix", request: "Corrige a PR #137 que está com lint vermelho.",
    objective: "Lint verde na PR #137.", spec: "1. Rodar pnpm quality:lint. 2. Não atualizar o baseline.",
    constraints: ["Não tocar em outros arquivos."], source: "https://github.com/o/r/pull/137", mode: "report",
  });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /## Pedido do usuário \(literal\)\nCorrige a PR #137/);
  assert.match(brief, /## Objetivo\nLint verde na PR #137/);
  assert.match(brief, /## Fonte\nhttps:\/\/github\.com\/o\/r\/pull\/137/);
  assert.match(brief, /Não tocar em outros arquivos/);
  assert.match(brief, /## Especificação de construção\n1\. Rodar pnpm quality:lint/);
  assert.match(brief, /## Critérios de conclusão/);
  assert.match(brief, /Não use orch_delegate nem orch_fix_red_prs/);
});

test("brief sem spec não tem seção de especificação, mas mantém o contrato", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.equal(brief.includes("## Especificação de construção"), false);
  assert.match(brief, /## Restrições/);
  assert.match(brief, /## Regras/);
});

test("direct-pr com branch: critérios de push, PR, checks e checkout da branch", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project, role: "fix", request: "PR 137", objective: "checks verdes",
    mode: "direct-pr", branch: "fm/al-issue-63-q1",
  });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /modo: direct-pr/);
  assert.match(brief, /Commit na branch `fm\/al-issue-63-q1`, push e PR/);
  assert.match(brief, /Checks do PR verificados/);
  assert.match(brief, /Faça checkout da branch `fm\/al-issue-63-q1`/);
});

test("delegate recusa pedido, objetivo ou modo inválidos e placeholders, sem lançar nada", async () => {
  const h = makeHarness();
  const base = { project_path: h.project, role: "a", mode: "report" as const };
  await assert.rejects(h.orch.delegate({ ...base, request: " ", objective: "y" }), /request vazio/);
  await assert.rejects(h.orch.delegate({ ...base, request: "x", objective: "" }), /objective vazio/);
  await assert.rejects(h.orch.delegate({ ...base, request: "{TASK}", objective: "y" }), /placeholder/);
  await assert.rejects(h.orch.delegate({ ...base, request: "x", objective: "y", mode: "ship" as never }), /mode inválido/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
  assert.equal(h.orch.list().length, 0);
});

test("modelo pedido e indisponível: erro explícito, sem substituição e sem worker", async () => {
  const h = makeHarness();
  await assert.rejects(
    h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", model: "claude-bridge/modelo-que-nao-existe" }),
    /modelo indisponível: "claude-bridge\/modelo-que-nao-existe"\. Nada foi lançado/,
  );
  assert.equal(h.herdr.opsOf("createTab").length, 0);
  assert.equal(h.orch.list().length, 0);
});

test("modelo pedido disponível vai para o pi e fica registrado", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", model: "claude-bridge/claude-haiku-5-5" });
  assert.equal(t.model, "claude-bridge/claude-haiku-5-5");
  const run = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.match(run, /--model claude-bridge\/claude-haiku-5-5/);
});

test("modo simulação (dryRun): valida, monta o brief e não toca no Herdr", async () => {
  const h = makeHarness();
  const planned = new Orchestrator({
    herdr: h.herdr, store: new Store(join(h.stateDir, "dry.json")), tasksDir: join(h.stateDir, "dry-tasks"),
    workerExtPath: "/x", now: () => h.clock.ms, newHex: () => "dddddddd",
    availableModels: () => ["claude-bridge/claude-haiku-5-5"], dryRun: true,
  });
  const t = await planned.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", model: "claude-bridge/claude-haiku-5-5" });
  assert.equal(t.status, "planned");
  assert.equal(h.herdr.calls.length, 0);
  assert.match(readFileSync(t.brief_path, "utf8"), /## Pedido do usuário \(literal\)/);
});

test("direct-pr sem branch: o brief manda o worker descobrir a branch da PR citada", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "fix", request: "PR #137", objective: "checks", mode: "direct-pr" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /gh pr view <número> --json headRefName/);
  assert.match(brief, /descubra a branch da PR citada/);
});

test("brief pede resumo de até 5 linhas no result e proíbe comentar em PR sem pedido", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /no máximo 5 linhas/);
  assert.match(brief, /Não comente nem publique em PR ou issue/);
});

test("o brief vai ao worker pela extensão (contexto), e o argumento de lançamento é curto", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "Pedido único XYZ", objective: "y", mode: "report" });
  const sent = readFileSync(t.brief_path, "utf8");
  assert.match(sent, /## Pedido do usuário \(literal\)\nPedido único XYZ/);
  assert.match(sent, /## Critérios de conclusão/);
  const launch = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.doesNotMatch(launch, /\n/, "comando de lançamento sem quebras de linha");
});

test("brief manda devolver a worktree só quando não há trabalho pendente", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /treehouse return/);
  assert.match(brief, /não devolva e informe o caminho/);
});

test("worker recebe nome visível worker-<projeto>-<id>", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const name = (h.herdr.opsOf("renamePane")[0].args as { label: string }).label;
  assert.equal(t.worker_id, name);
  assert.match(name, /^worker-/);
});

test("modo design: fluxo grill/plan/spec/tickets, oracle com regra de fatias verticais, tracker no brief", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "design", request: "Quero o módulo de simulação", objective: "Issues prontas para implementação", mode: "design", tracker: "plane" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /grill-with-docs/);
  assert.match(brief, /to-tickets/);
  assert.match(brief, /subagent `oracle`/);
  assert.match(brief, /fatias verticais/);
  assert.match(brief, /Fatia horizontal .* é reprovada/);
  assert.match(brief, /Tracker de issues do projeto: plane/);
});

test("refresh lê o relatório em disco: done vira evento uma vez, e depois não repete", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "achei 3 falhas", artifacts: ["/r.md"] });
  const ev = await h.orch.refresh(t.task_id);
  assert.equal(ev?.status, "done");
  assert.equal(ev?.result, "achei 3 falhas");
  assert.equal(await h.orch.refresh(t.task_id), null, "mesmo relatório não gera evento de novo");
  assert.equal(h.orch.takeNotice(t.task_id), true);
  assert.equal(h.orch.takeNotice(t.task_id), false);
});

test("bloqueio: refresh traz a pergunta; resposta reabre; novo relatório conclui", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Usar A ou B?" }, "1");
  const ev = await h.orch.refresh(t.task_id);
  assert.equal(ev?.status, "blocked");
  assert.equal(ev?.question, "Usar A ou B?");
  assert.deepEqual((await h.orch.inbox()).map((i) => i.status), ["blocked"]);
  await h.orch.answer(t.task_id, "Use A");
  writeReport(t.task_dir, t.task_id, { status: "done", result: "feito com A" }, "2");
  assert.equal((await h.orch.refresh(t.task_id))?.status, "done");
});

test("done não fecha a tab: quem fecha é o orquestrador via close", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  assert.equal(h.herdr.opsOf("closeTab").length, 0);
  assert.ok(h.herdr.panesList.some((p) => p.pane_id === t.pane_id));
  await h.orch.close(t.task_id);
  assert.equal(h.herdr.opsOf("closeTab").at(-1)?.args, t.tab_id);
});

test("failed não fecha a tab (fica para inspeção)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "failed", result: "não deu" });
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "failed");
  assert.equal(h.herdr.opsOf("closeTab").length, 0);
});

test("pane sumido sem relatório vira lost, com relatório vira done", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "x", objective: "y", mode: "report" });
  h.herdr.panesList = h.herdr.panesList.filter((p) => p.pane_id !== a.pane_id && p.pane_id !== b.pane_id);
  writeReport(b.task_dir, b.task_id, { status: "done", result: "salvo" });
  assert.equal((await h.orch.refresh(a.task_id))?.status, "lost");
  assert.equal((await h.orch.refresh(b.task_id))?.status, "done");
});

test("worker recebe o endereço e o token do webhook do orquestrador", async () => {
  const h = makeHarness();
  h.orch.setHook("http://127.0.0.1:4555/hook", "tok123");
  await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const env = (h.herdr.opsOf("createTab")[0].args as { env: Record<string, string> }).env;
  assert.equal(env.PI_ORCH_HOOK_URL, "http://127.0.0.1:4555/hook");
  assert.equal(env.PI_ORCH_HOOK_TOKEN, "tok123");
});

test("onTerminal avisa a fila quando a tarefa termina", async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const orch = new Orchestrator({
    herdr: h.herdr, store: new Store(join(h.stateDir, "ot.json")), tasksDir: join(h.stateDir, "ot-tasks"),
    workerExtPath: "/x", now: () => h.clock.ms, newHex: () => "eeeeeeee", availableModels: () => ["claude-bridge/claude-haiku-5-5"], dryRun: false,
    onTerminal: (id) => seen.push(id),
  });
  const t = await orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await orch.refresh(t.task_id);
  assert.deepEqual(seen, [t.task_id]);
});

test("ao abrir a sessão só avisa o que é novo: bloqueio já anunciado não volta", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Qual caminho?" }, "1");
  await h.orch.refresh(t.task_id);
  assert.equal((await h.orch.pendingNotices()).length, 1, "bloqueio novo é avisado");
  assert.equal((await h.orch.pendingNotices()).length, 0, "não reanuncia na próxima abertura");
  assert.equal(h.orch.get(t.task_id).status, "blocked", "continua bloqueado até resposta");
});

test("brief de PR: primeiro consultar o estado de merge e resolver conflito antes de editar", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "fix", request: "PR 136", objective: "checks verdes", mode: "direct-pr", source: "https://github.com/o/r/pull/136", branch: "fm/x" });
  const brief = readFileSync(t.brief_path, "utf8");
  assert.match(brief, /3\. Antes de editar, consulte o estado de merge da PR/);
  assert.match(brief, /resolva o conflito no branch da PR primeiro/);
});

test("enrichSource lê o estado da PR no lançamento (não na listagem)", async () => {
  const h = makeHarness();
  const { Orchestrator } = await import("../src/orchestrator.ts");
  const { Store } = await import("../src/store.ts");
  const orch = new Orchestrator({
    herdr: h.herdr, store: new Store(join(h.stateDir, "e.json")), tasksDir: join(h.stateDir, "e-tasks"),
    workerExtPath: "/x", now: () => h.clock.ms, newHex: () => "fefefefe", availableModels: () => [], dryRun: false,
    enrichSource: async (i) => ({ ...i, constraints: [...(i.constraints ?? []), "PR com conflito agora"] }),
  });
  const t = await orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  assert.match(readFileSync(t.brief_path, "utf8"), /PR com conflito agora/);
});

test("relatório tardio reabre tarefa failed/timeout/lost: o estado segue o último relatório", async () => {
  for (const first of ["failed", "timeout", "lost"] as const) {
    const h = makeHarness();
    const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", timeout_minutes: first === "timeout" ? 1 : undefined });
    if (first === "failed") writeReport(t.task_dir, t.task_id, { status: "failed", result: "erro 500 do modelo" }, "1");
    if (first === "lost") h.herdr.panesList = [];
    if (first === "timeout") h.clock.ms += 2 * 60_000;
    await h.orch.refresh(t.task_id);
    assert.equal(h.orch.get(t.task_id).status, first);
    h.orch.takeNotice(t.task_id);
    writeReport(t.task_dir, t.task_id, { status: "done", result: "feito depois" }, "2");
    const ev = await h.orch.refresh(t.task_id);
    assert.equal(ev?.status, "done", `${first} -> done`);
    assert.equal(h.orch.get(t.task_id).notified, false, "volta a ter aviso pendente");
  }
});

test("tarefa cancelada não é reaberta por relatório tardio", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await h.orch.cancel(t.task_id);
  writeReport(t.task_dir, t.task_id, { status: "done", result: "tarde" });
  assert.equal(await h.orch.refresh(t.task_id), null);
  assert.equal(h.orch.get(t.task_id).status, "cancelled");
});

test("noticeFor avisa uma vez, mesmo que outro refresh já tenha aplicado o relatório", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id); // ex.: o LLM chamou orch_status antes do webhook chegar
  const ev = await h.orch.noticeFor(t.task_id);
  assert.equal(ev?.status, "done");
  assert.equal(await h.orch.noticeFor(t.task_id), null, "não repete");
});

test("sweep acha sozinho conclusões sem webhook, inclusive de tarefa que estava failed", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "x", objective: "y", mode: "report" });
  writeReport(b.task_dir, b.task_id, { status: "failed", result: "500" }, "1");
  assert.deepEqual((await h.orch.sweep()).map((e) => e.task_id), [b.task_id]);
  writeReport(a.task_dir, a.task_id, { status: "done", result: "ok" });
  writeReport(b.task_dir, b.task_id, { status: "done", result: "depois" }, "2");
  const got = (await h.orch.sweep()).map((e) => `${e.task_id}:${e.status}`).sort();
  assert.deepEqual(got, [`${a.task_id}:done`, `${b.task_id}:done`].sort());
  assert.deepEqual(await h.orch.sweep(), [], "nada novo, nada avisado");
});

test("brief não proíbe subagents e skills internos do Pi, em nenhum modo", async () => {
  const { buildIntake, renderBrief, MODES } = await import("../src/intake.ts");
  const h = makeHarness();
  for (const mode of MODES) {
    const brief = renderBrief("t-x", buildIntake({ project_path: h.project, role: "a", request: "x", objective: "y", mode }), "/r.json");
    assert.doesNotMatch(brief, /não delegue sub-tarefas/, `modo ${mode}`);
    assert.match(brief, /subagents internos do Pi e skills são permitidos/i, `modo ${mode}`);
    assert.match(brief, /não use orch_delegate/i, `modo ${mode}: continua sem poder lançar workers`);
  }
});

test("brief de modo design: a instrução de oracle e o que o worker pode usar não se contradizem", async () => {
  const { buildIntake, renderBrief } = await import("../src/intake.ts");
  const h = makeHarness();
  const brief = renderBrief("t-x", buildIntake({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "design" }), "/r.json");
  assert.match(brief, /subagent `oracle`/);
  assert.doesNotMatch(brief, /não delegue/);
});
