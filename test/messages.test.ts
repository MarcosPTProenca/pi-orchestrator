import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatEvent, modelMessageFor, FIRST_MATE_ROLE } from "../src/orchestrator/extension.ts";
import { makeHarness, writeReport } from "./fakes.ts";

const base = { task_id: "t-abcdef123456", project_id: "rko", result: null, question: null, artifacts: [], error: null };

test("mensagem de conclusão traz resultado, sem campos técnicos", () => {
  const msg = formatEvent({ ...base, status: "done", result: "3 falhas", artifacts: ["/r.md"] } as never);
  assert.equal(msg, "[123456] rko: concluído. 3 falhas\nArquivos: /r.md");
});

test("bloqueio apresenta a decisão ao usuário", () => {
  const msg = formatEvent({ ...base, status: "blocked", question: "A ou B?" } as never);
  assert.match(msg, /precisa de uma decisão: A ou B\?/);
});

test("prazo vencido pergunta o que fazer, não diz que vai cancelar sozinho", () => {
  const msg = formatEvent({ ...base, status: "timeout" } as never);
  assert.match(msg, /Quer que eu cancele\?/);
});

test("papel do orquestrador: não executa trabalho de projeto e lança pelas tools", () => {
  assert.match(FIRST_MATE_ROLE, /Não executa o trabalho do projeto/);
  assert.match(FIRST_MATE_ROLE, /orch_delegate/);
  assert.match(FIRST_MATE_ROLE, /orch_fix_red_prs/);
  assert.match(FIRST_MATE_ROLE, /orch_locate_project antes de perguntar/);
});

test("launcher não exclui ferramentas: subagents de pesquisa ficam disponíveis", () => {
  const bin = readFileSync(join(process.cwd(), "bin", "pi-orch"), "utf8");
  assert.doesNotMatch(bin, /--exclude-tools/);
});

const userSettings = join(homedir(), ".pi", "agent", "settings.json");
test(
  "worker do pi-subagents está desabilitado no settings do usuário",
  { skip: !existsSync(userSettings) && "settings.json do usuário ausente" },
  () => {
    const settings = JSON.parse(readFileSync(userSettings, "utf8"));
    assert.equal(settings.subagents.agentOverrides.worker.disabled, true);
  },
);

test("mensagem ao orquestrador pede resumo curto e não cola o relatório", () => {
  const long = "x".repeat(5000);
  const msg = modelMessageFor({
    ...base,
    status: "done",
    result: long,
    artifacts: ["https://github.com/o/r/pull/1"],
  } as never);
  assert.match(msg, /\[evento de worker\]/);
  assert.match(msg, /Responda ao usuário em até 5 linhas/);
  assert.match(msg, /truncado/);
  assert.ok(msg.length < 2000, "bruto não cabe inteiro");
  assert.match(msg, /https:\/\/github\.com\/o\/r\/pull\/1/);
});

test("nome do orquestrador no Herdr: orquestrador-<pasta>, no padrão aceito", async () => {
  const { orchestratorAgentName } = await import("../src/shared/label.ts");
  assert.equal(orchestratorAgentName("/home/marcos_pinho/github/pi-orchestrator"), "orquestrador-pi-orchestrator");
  assert.equal(orchestratorAgentName("/x/Job Planejamento_Oferta!"), "orquestrador-job-planejamento-of");
  const n = orchestratorAgentName("/x/" + "a".repeat(80));
  assert.match(n, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(orchestratorAgentName("/x/---"), "orquestrador-sessao");
});

test("horário exibido é o de Brasília (America/Sao_Paulo)", async () => {
  const { formatBrasilia } = await import("../src/orchestrator/extension.ts");
  assert.match(formatBrasilia("2026-11-16T19:44:15Z") ?? "", /16\/11\/2026.*16:44/);
  assert.equal(formatBrasilia(null), null);
});

test("nome do worker no Herdr: worker-<projeto>-<id>, no padrão aceito", async () => {
  const { workerAgentName } = await import("../src/shared/label.ts");
  const n = workerAgentName("/home/u/github/adaptative-learning", "a1b2c3d4e5");
  assert.equal(n, "worker-adaptative-lea-a1b2c3");
  assert.match(n, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(workerAgentName("/x/" + "z".repeat(60), "9f"), /^[a-z][a-z0-9_-]{0,31}$/);
});

test("sem prazo pedido, refresh nunca marca timeout, mesmo após horas", async () => {
  const { makeHarness } = await import("./fakes.ts");
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  assert.equal(t.deadline_at, null);
  h.clock.ms += 10 * 3600_000;
  assert.equal(await h.orch.refresh(t.task_id), null);
  assert.equal(h.orch.get(t.task_id).status, "running");
});

test("prazo explícito: refresh marca timeout quando o usuário pediu", async () => {
  const { makeHarness } = await import("./fakes.ts");
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
    timeout_minutes: 5,
  });
  h.clock.ms += 6 * 60_000;
  const ev = await h.orch.refresh(t.task_id);
  assert.equal(ev?.status, "timeout");
  assert.match(ev?.error ?? "", /prazo definido por você/);
});

test("papel proíbe recomendar ação pública que o usuário não pediu", () => {
  assert.match(FIRST_MATE_ROLE, /Nunca recomende nem proponha como opção uma ação pública/);
  assert.match(FIRST_MATE_ROLE, /quando um worker reportar uma decisão nova/);
});

test("papel aciona subagents para pesquisa e levantamento, sem pesquisar sozinho", () => {
  assert.match(FIRST_MATE_ROLE, /Pesquisa e levantamento não são seus/);
  assert.match(FIRST_MATE_ROLE, /`researcher`/);
  assert.match(FIRST_MATE_ROLE, /`log-researcher`/);
  assert.match(FIRST_MATE_ROLE, /Nunca pesquise ou levante sozinho/);
});

test("papel executa pedido claro e relata o erro quando falha", () => {
  assert.match(FIRST_MATE_ROLE, /Pedido claro dentro do seu papel/);
  assert.match(FIRST_MATE_ROLE, /diga a tentativa e o erro exato/);
});

test("papel não trata discovery para criar issue ou card como trabalho de worker (#52)", () => {
  assert.match(FIRST_MATE_ROLE, /Discovery para criar issue ou card não é trabalho novo de worker/);
});

test("papel conduz discovery e entrevista diretamente, sem delegar a worker (regressão #61)", () => {
  assert.match(FIRST_MATE_ROLE, /Discovery e entrevista com o usuário são seus/);
  assert.match(FIRST_MATE_ROLE, /`grill-with-docs`, `to-spec` e `to-tickets`/);
  assert.match(FIRST_MATE_ROLE, /Não lance worker para conduzir essas etapas/);
  assert.match(FIRST_MATE_ROLE, /Subagents só levantam fatos/);
});

test("pergunta de acompanhamento: responde com o que já existe, data e lacuna, sem relançar (#57)", () => {
  assert.match(FIRST_MATE_ROLE, /Pergunta de acompanhamento sobre tarefa anterior/);
  assert.match(FIRST_MATE_ROLE, /com a data absoluta do relatório \(AAAA-MM-DD, não só a idade\)/);
  assert.match(FIRST_MATE_ROLE, /Investigue só a lacuna, nunca refaça trabalho/);
  assert.match(FIRST_MATE_ROLE, /pode estar desatualizado/);
});

test("aviso de falha com recuperação: o rodapé manda repetir a linha de recuperação ao usuário (#64)", () => {
  const msg = modelMessageFor({
    task_id: "t-r1",
    project_id: "p",
    status: "failed",
    result: "Encerrou com erro do modelo",
    question: null,
    artifacts: [],
    error: null,
    correction: null,
  } as never);
  assert.match(msg, /repita essa linha para o usuário/);
  assert.match(msg, /Nenhuma recuperação é executada sem o pedido dele/);
});

test("pergunta sem resposta depois do prazo: avisa uma vez, segue bloqueada, não cancela sozinha (#63)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
    timeout_minutes: 5,
  } as never);
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "A ou B?" }, "1");
  await h.orch.refresh(t.task_id);
  h.clock.ms += 6 * 60_000;
  const first = await h.orch.refresh(t.task_id);
  assert.ok(first, "o prazo vencido gera um aviso");
  assert.equal(first.status, "blocked");
  assert.match(first.error ?? "", /venceu enquanto a tarefa aguardava sua resposta; segue bloqueada/);
  assert.equal(h.orch.get(t.task_id).status, "blocked", "não cancela sozinha");
  assert.equal(await h.orch.refresh(t.task_id), null, "avisa uma vez só");
});

test("pergunta repetida pelo worker não reabre o aviso; pergunta nova avisa de novo (#63)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
  } as never);
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "A ou B?" }, "1");
  assert.ok(await h.orch.noticeFor(t.task_id), "primeira pergunta avisa");
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "A ou B?" }, "2");
  assert.equal(await h.orch.noticeFor(t.task_id), null, "mesma pergunta repetida não avisa de novo");
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "C ou D?" }, "3");
  assert.ok(await h.orch.noticeFor(t.task_id), "pergunta nova avisa");
});
