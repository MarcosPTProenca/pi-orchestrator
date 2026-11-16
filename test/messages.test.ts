import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatEvent, modelMessageFor, FIRST_MATE_ROLE } from "../src/index.ts";

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

test("launcher não exclui ferramentas: subagents de pesquisa ficam disponíveis; worker está desabilitado no settings", () => {
  const bin = readFileSync(join(process.cwd(), "bin", "pi-orch"), "utf8");
  assert.doesNotMatch(bin, /--exclude-tools/);
  const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
  assert.equal(settings.subagents.agentOverrides.worker.disabled, true);
});

test("mensagem ao orquestrador pede resumo curto e não cola o relatório", () => {
  const long = "x".repeat(5000);
  const msg = modelMessageFor({ ...base, status: "done", result: long, artifacts: ["https://github.com/o/r/pull/1"] } as never);
  assert.match(msg, /\[evento de worker\]/);
  assert.match(msg, /Responda ao usuário em até 5 linhas/);
  assert.match(msg, /truncado/);
  assert.ok(msg.length < 2000, "bruto não cabe inteiro");
  assert.match(msg, /https:\/\/github\.com\/o\/r\/pull\/1/);
});

test("nome do orquestrador no Herdr: orquestrador-<pasta>, no padrão aceito", async () => {
  const { orchestratorAgentName } = await import("../src/label.ts");
  assert.equal(orchestratorAgentName("/home/marcos_pinho/github/pi-orchestrator"), "orquestrador-pi-orchestrator");
  assert.equal(orchestratorAgentName("/x/Job Planejamento_Oferta!"), "orquestrador-job-planejamento-of");
  const n = orchestratorAgentName("/x/" + "a".repeat(80));
  assert.match(n, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(orchestratorAgentName("/x/---"), "orquestrador-sessao");
});

test("sem prazo pedido, o watcher nunca marca timeout (mesmo após horas)", async () => {
  const { makeHarness, writeReport } = await import("./fakes.ts");
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  assert.equal(t.deadline_at, null);
  h.clock.ms += 10 * 3600_000;
  let calls = 0;
  h.herdr.waitImpl = async () => {
    calls++;
    if (calls === 3) writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
    return { timeout: true };
  };
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "done");
});

test("prazo explícito continua valendo quando o usuário o pede", async () => {
  const { makeHarness } = await import("./fakes.ts");
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", timeout_minutes: 5 });
  h.clock.ms += 6 * 60_000;
  h.herdr.waitImpl = async () => ({ timeout: true });
  const ev = await h.orch.watch(t.task_id, new AbortController().signal);
  assert.equal(ev?.status, "timeout");
  assert.match(ev?.error ?? "", /prazo definido por você/);
});

test("horário exibido é o de Brasília (America/Sao_Paulo)", async () => {
  const { formatBrasilia } = await import("../src/index.ts");
  assert.match(formatBrasilia("2026-11-16T19:44:15Z") ?? "", /16\/11\/2026.*16:44/);
  assert.equal(formatBrasilia(null), null);
});

test("nome do worker no Herdr: worker-<projeto>-<id>, no padrão aceito", async () => {
  const { workerAgentName } = await import("../src/label.ts");
  const n = workerAgentName("/home/u/github/adaptative-learning", "a1b2c3d4e5");
  assert.equal(n, "worker-adaptative-lea-a1b2c3");
  assert.match(n, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(workerAgentName("/x/" + "z".repeat(60), "9f"), /^[a-z][a-z0-9_-]{0,31}$/);
});
