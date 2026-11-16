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
  const start = h.herdr.opsOf("startAgent")[0].args as { paneId: string; piArgs: string[] };
  assert.equal(start.paneId, t.pane_id);
  assert.deepEqual(start.piArgs, ["-e", "/fake/worker-ext.ts"]);
  assert.match(readFileSync(t.brief_path, "utf8"), /Analise o login/);
  assert.match(readFileSync(t.brief_path, "utf8"), /orch_report/);
  assert.equal(h.herdr.opsOf("prompt").length, 1);
});

test("a tab seed fica como âncora do projeto: nenhuma tab é fechada ao criar tarefa", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  assert.equal(h.herdr.opsOf("closeTab").length, 0);
  assert.ok(h.herdr.workspaces.has(t.workspace_id));
  assert.ok(h.herdr.panesList.some((p) => p.pane_id.startsWith(`${t.workspace_id}:`)));
});

test("tarefas do mesmo projeto reutilizam o workspace; projetos diferentes ganham outro", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "1", objective: "1", mode: "report" });
  h.herdr.waitImpl = async () => ({ timeout: true });
  h.clock.ms += 1;
  writeReport(a.task_dir, a.task_id, { status: "done", result: "ok" });
  await h.orch.watch(a.task_id, new AbortController().signal);
  const b = await h.orch.delegate({ project_path: h.project, role: "b", request: "2", objective: "2", mode: "report" });
  assert.equal(b.workspace_id, a.workspace_id);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 1);

  const other = mkdtempSync(join(tmpdir(), "orch-other-"));
  mkdirSync(join(other, ".git"));
  writeReport(b.task_dir, b.task_id, { status: "done", result: "ok" }, "x2");
  await h.orch.watch(b.task_id, new AbortController().signal);
  const c = await h.orch.delegate({ project_path: other, role: "c", request: "3", objective: "3", mode: "report" });
  assert.notEqual(c.workspace_id, a.workspace_id);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 2);
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
  await assert.rejects(h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" }), /start falhou/);
  const closes = h.herdr.opsOf("closeTab").map((o) => o.args);
  const failed = h.orch.list()[0];
  assert.equal(closes.at(-1), failed.tab_id);
  assert.equal(failed.status, "failed");
});

test("done NÃO fecha a tab: quem fecha é o orquestrador via close, depois de validar", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.waitImpl = async () => {
    writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
    return { reached: "idle" };
  };
  await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(h.herdr.opsOf("closeTab").length, 0, "conclusão não fecha tab");
  assert.ok(h.herdr.panesList.some((p) => p.pane_id === t.pane_id), "pane da tarefa segue aberto");
  await h.orch.close(t.task_id);
  assert.equal(h.herdr.opsOf("closeTab").at(-1)?.args, t.tab_id);
  assert.equal(h.herdr.panesList.some((p) => p.pane_id === t.pane_id), false);
  assert.match(readFileSync(join(t.task_dir, "report.json"), "utf8"), /"status":"done"/);
});

test("close recusa tab trocada (terminal_id diferente)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.panesList = h.herdr.panesList.map((p) => (p.pane_id === t.pane_id ? { ...p, terminal_id: "outro" } : p));
  const before = h.herdr.opsOf("closeTab").length;
  await assert.rejects(h.orch.close(t.task_id), /não corresponde/);
  assert.equal(h.herdr.opsOf("closeTab").length, before);
});

test("failed e blocked não fecham a tab (para inspeção)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.waitImpl = async () => ({ reached: "idle" });
  const before = h.herdr.opsOf("closeTab").length;
  await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(h.orch.get(t.task_id).status, "failed");
  assert.equal(h.herdr.opsOf("closeTab").length, before);
});

test("watch devolve done com resultado e dedupe impede aviso repetido", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.waitImpl = async () => {
    writeReport(t.task_dir, t.task_id, { status: "done", result: "achei 3 falhas", artifacts: ["/r.md"] });
    return { reached: "idle" };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "done");
  assert.equal(ev?.result, "achei 3 falhas");
  assert.equal(h.orch.takeNotice(t.task_id), true);
  assert.equal(h.orch.takeNotice(t.task_id), false);
  assert.equal(h.orch.inbox().length, 0, "terminal já avisado não reaparece no inbox");
  assert.equal(h.orch.collect(t.task_id), false, "mesmo relatório não é reprocessado");
});

test("watch espera 'working' antes de aceitar 'idle' (evita ler o idle anterior ao início)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const seen: string[][] = [];
  h.herdr.waitImpl = async (_target, until) => {
    seen.push(until);
    if (until.includes("working")) return { reached: "working" };
    writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
    return { reached: "idle" };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "done");
  assert.deepEqual(seen[0], ["working"]);
  assert.ok(seen[1].includes("idle"));
});

test("bloqueio: pergunta aparece no inbox, resposta reabre o worker e novo relatório conclui", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.waitImpl = async () => {
    writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Usar A ou B?" }, "1");
    return { reached: "blocked" };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "blocked");
  assert.equal(ev?.question, "Usar A ou B?");
  assert.deepEqual(h.orch.inbox().map((i) => i.status), ["blocked"]);
  assert.deepEqual(h.orch.inbox().map((i) => i.status), ["blocked"], "decisão aberta continua no inbox");

  await h.orch.answer(t.task_id, "Use A");
  const sent = h.herdr.opsOf("prompt").at(-1)?.args as { target: string; text: string };
  assert.equal(sent.text, "Use A");
  assert.equal(h.orch.get(t.task_id).status, "running");

  h.herdr.waitImpl = async () => {
    writeReport(t.task_dir, t.task_id, { status: "done", result: "feito com A" }, "2");
    return { reached: "idle" };
  };
  const done = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(done?.status, "done");
});

test("answer rejeita tarefa que não está bloqueada", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  await assert.rejects(h.orch.answer(t.task_id, "oi"), /não está bloqueada/);
});

test("worker ocioso sem nunca ter trabalhado recebe o brief uma única vez de novo", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  let round = 0;
  h.herdr.waitImpl = async (_target, until) => {
    if (until.includes("working")) return { timeout: true };
    round++;
    if (round === 2) writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
    return { reached: "idle" };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "done");
  assert.equal(h.herdr.opsOf("prompt").length, 2, "brief enviado de novo uma vez");
  assert.equal(h.orch.get(t.task_id).prompt_attempts, 2);
});

test("worker que já trabalhou e ficou ocioso sem relatório recebe um lembrete, depois falha com a última saída", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.recentText = "Marcos, sem pedido ainda. O que precisa?";
  h.herdr.waitImpl = async (_t, until) => (until.includes("working") ? { reached: "working" } : { reached: "idle" });
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "failed");
  assert.equal(h.herdr.opsOf("prompt").length, 2, "um reenvio com lembrete");
  const reminder = (h.herdr.opsOf("prompt")[1].args as { text: string }).text;
  assert.match(reminder, /ainda não chamou orch_report/);
  assert.match(ev?.error ?? "", /Última saída do worker: Marcos, sem pedido ainda/);
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
  const start = h.herdr.opsOf("startAgent")[0].args as { piArgs: string[] };
  assert.deepEqual(start.piArgs, ["-e", "/fake/worker-ext.ts", "--model", "claude-bridge/claude-haiku-5-5"]);
  assert.equal(t.model, "claude-bridge/claude-haiku-5-5");
});

test("delegate sem model não passa --model (padrão do Pi)", async () => {
  const h = makeHarness();
  await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const start = h.herdr.opsOf("startAgent")[0].args as { piArgs: string[] };
  assert.equal(start.piArgs.includes("--model"), false);
});

test("delegate recusa project_path que não é raiz de repositório git (ex.: diretório pai)", async () => {
  const h = makeHarness();
  const parent = mkdtempSync(join(tmpdir(), "orch-parent-"));
  await assert.rejects(h.orch.delegate({ project_path: parent, role: "a", request: "x", objective: "x", mode: "report" }), /não é a raiz de um repositório git/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
});


test("worker ocioso sem orch_report vira failed", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  h.herdr.waitImpl = async () => ({ reached: "idle" });
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "failed");
  assert.match(ev?.error ?? "", /sem chamar orch_report/);
});

test("timeout de bloco não encerra; prazo vencido marca timeout sem fechar a tab", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report", timeout_minutes: 1 });
  const before = h.herdr.opsOf("closeTab").length;
  h.herdr.waitImpl = async () => {
    h.clock.ms += 61_000;
    return { timeout: true };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "timeout");
  assert.equal(h.herdr.opsOf("closeTab").length, before);
});

test("watch é encerrado pelo AbortSignal sem evento", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "x", mode: "report" });
  const ac = new AbortController();
  ac.abort();
  assert.equal(await h.orch.watch(t.task_id, ac.signal), null);
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
  assert.match(brief, /Não lance outros workers/);
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
  const start = h.herdr.opsOf("startAgent")[0].args as { piArgs: string[] };
  assert.deepEqual(start.piArgs.slice(-2), ["--model", "claude-bridge/claude-haiku-5-5"]);
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

test("o brief vai inline no prompt do worker; o worker não depende de ler arquivo", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "Pedido único XYZ", objective: "y", mode: "report" });
  const sent = (h.herdr.opsOf("prompt")[0].args as { text: string }).text;
  assert.match(sent, /## Pedido do usuário \(literal\)\nPedido único XYZ/);
  assert.match(sent, /## Critérios de conclusão/);
  assert.doesNotMatch(sent, /Leia o arquivo/);
  assert.match(sent, /chame orch_report/);
});
