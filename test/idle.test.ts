import { test } from "node:test";
import assert from "node:assert/strict";
import { closeBlocker, deadTabTaskIds, idleReport, IdleWatch, idleAnnouncement, idleSurfaces, whyNotIdle, type LiveSurfaces } from "../src/idle.ts";
import { parseTabIds } from "../src/herdr.ts";
import type { TaskRecord } from "../src/contract.ts";

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    task_id: "t-x",
    project_id: "p",
    tab_id: "w1:t1",
    pane_id: "w1:t1-1",
    terminal_id: "term-1",
    status: "done",
    notified: true,
    updated_at: "2026-11-18T10:00:00.000Z",
    ...over,
  } as TaskRecord;
}

/** Herdr em que a tab e o pane/terminal da tarefa ainda existem. */
function liveFor(...tasks: TaskRecord[]): LiveSurfaces {
  return {
    tabIds: new Set(tasks.map((t) => t.tab_id)),
    panes: tasks.map((t) => ({ pane_id: t.pane_id, terminal_id: t.terminal_id, cwd: null, agent: null, agent_status: null })),
  };
}

test("done e já entregue com tab confirmada no Herdr é candidata a fechar", () => {
  const t = task({ task_id: "t-a" });
  assert.deepEqual(idleSurfaces([t], liveFor(t)).map((s) => s.task_id), ["t-a"]);
});

test("tarefas que ainda pedem atenção ficam de fora", () => {
  const tasks = [
    task({ task_id: "t-running", status: "running", notified: false }),
    task({ task_id: "t-blocked", status: "blocked", notified: false }),
    task({ task_id: "t-failed", status: "failed" }),
    task({ task_id: "t-lost", status: "lost" }),
    task({ task_id: "t-cancelled", status: "cancelled" }),
    task({ task_id: "t-unread", notified: false }),
  ];
  assert.deepEqual(idleSurfaces(tasks, liveFor(...tasks)), []);
});

test("sem tab registrada não há superfície a fechar", () => {
  const t = task({ tab_id: "" });
  assert.deepEqual(idleSurfaces([t], liveFor(t)), []);
});

test("tab registrada que o Herdr não lista mais não é lembrada", () => {
  const t = task({ task_id: "t-fechada" });
  assert.deepEqual(idleSurfaces([t], { tabIds: new Set(), panes: liveFor(t).panes }), []);
});

test("tab reutilizada por outro terminal não conta como da tarefa", () => {
  const t = task({ task_id: "t-reusada", terminal_id: "term-antigo" });
  const live = { tabIds: new Set([t.tab_id]), panes: [{ pane_id: t.pane_id, terminal_id: "term-novo", cwd: null, agent: null, agent_status: null }] };
  assert.deepEqual(idleSurfaces([t], live), []);
});

test("ordena pela data de atualização, a mais antiga primeiro, e marca workspace próprio", () => {
  const nova = task({ task_id: "t-nova", updated_at: "2026-11-18T12:00:00.000Z" });
  const velha = task({ task_id: "t-velha", updated_at: "2026-11-16T09:00:00.000Z", projected: true, tab_id: "w2:t1", pane_id: "w2:t1-1", terminal_id: "term-2" });
  const out = idleSurfaces([nova, velha], liveFor(nova, velha));
  assert.deepEqual(out.map((s) => [s.task_id, s.projected]), [["t-velha", true], ["t-nova", false]]);
});

test("parseTabIds lê os tab_id de tab list", () => {
  const json = { id: "cli:tab:list", result: { tabs: [{ tab_id: "w1:t1" }, { tab_id: "w1:t2" }], type: "tab_list" } };
  assert.deepEqual([...parseTabIds(json)].sort(), ["w1:t1", "w1:t2"]);
});

test("parseTabIds rejeita resposta sem tabs", () => {
  assert.throws(() => parseTabIds({ result: {} }), /sem tabs/);
});

test("aviso periódico só sai quando o conjunto de candidatas muda", () => {
  const a = { task_id: "t-a", project_id: "p", updated_at: "x", projected: false };
  const b = { task_id: "t-b", project_id: "p", updated_at: "y", projected: false };
  const first = idleAnnouncement("", [a]);
  assert.deepEqual(first, { announce: true, key: "t-a" });
  assert.deepEqual(idleAnnouncement(first.key, [a]), { announce: false, key: "t-a" });
  assert.deepEqual(idleAnnouncement("t-a", [a, b]), { announce: true, key: "t-a,t-b" });
});

test("sair de candidata não avisa de novo: só candidata nova acorda o orquestrador", () => {
  const a = { task_id: "t-a", project_id: "p", updated_at: "x", projected: false };
  const b = { task_id: "t-b", project_id: "p", updated_at: "y", projected: false };
  assert.deepEqual(idleAnnouncement("t-a,t-b", [a]), { announce: false, key: "t-a" });
  assert.deepEqual(idleAnnouncement("t-a", [a, b]), { announce: true, key: "t-a,t-b" });
});

test("lista vazia não avisa e zera a chave, para avisar de novo se a tarefa reaparecer", () => {
  const a = { task_id: "t-a", project_id: "p", updated_at: "x", projected: false };
  assert.deepEqual(idleAnnouncement("t-a", []), { announce: false, key: "" });
  assert.deepEqual(idleAnnouncement("", [a]), { announce: true, key: "t-a" });
});

test("whyNotIdle explica cada inelegibilidade e é null para candidata", () => {
  const ok = task({ task_id: "t-ok" });
  const live = liveFor(ok);
  assert.equal(whyNotIdle(ok, live), null);
  assert.match(whyNotIdle(task({ status: "running", notified: false }), live) ?? "", /em andamento/);
  assert.match(whyNotIdle(task({ status: "blocked", notified: false }), live) ?? "", /decis/);
  assert.match(whyNotIdle(task({ status: "failed" }), live) ?? "", /failed/);
  assert.match(whyNotIdle(task({ status: "cancelled" }), live) ?? "", /cancelada/);
  assert.match(whyNotIdle(task({ notified: false }), live) ?? "", /não entregue/);
  assert.match(whyNotIdle(task({ tab_id: "" }), live) ?? "", /sem tab/);
  assert.match(whyNotIdle(ok, { tabIds: new Set(), panes: [] }) ?? "", /não confere/);
});

test("whyNotIdle e idleSurfaces concordam: candidata é exatamente a que não tem motivo", () => {
  const tasks = [task({ task_id: "t-a" }), task({ task_id: "t-b", status: "failed" }), task({ task_id: "t-c", notified: false })];
  const live = liveFor(...tasks);
  const candidatas = tasks.filter((t) => whyNotIdle(t, live) === null).map((t) => t.task_id);
  assert.deepEqual(idleSurfaces(tasks, live).map((s) => s.task_id), candidatas);
});

test("closeBlocker recusa tarefa ativa e libera as demais", () => {
  assert.match(closeBlocker(task({ status: "running", task_id: "t-r" })) ?? "", /t-r ainda está running/);
  assert.match(closeBlocker(task({ status: "starting" })) ?? "", /starting/);
  assert.equal(closeBlocker(task({ status: "blocked" })) === null, false);
  assert.equal(closeBlocker(task({ status: "done" })), null);
  assert.equal(closeBlocker(task({ status: "failed" })), null);
});

test("transição ativa -> concluída vira candidata e avisa uma vez, sem reiniciar", () => {
  const w = new IdleWatch();
  const running = task({ task_id: "t-x", status: "running", notified: false });
  assert.equal(w.observe(idleSurfaces([running], liveFor(running))), false);
  const done = task({ task_id: "t-x", status: "done", notified: true });
  assert.equal(w.observe(idleSurfaces([done], liveFor(done))), true);
  assert.equal(w.observe(idleSurfaces([done], liveFor(done))), false);
});

test("reload (shutdown zera o watcher): a mesma candidata volta a ser avisada uma vez", () => {
  const w = new IdleWatch();
  const a = task({ task_id: "t-a" });
  assert.equal(w.observe(idleSurfaces([a], liveFor(a))), true);
  w.reset();
  assert.equal(w.observe(idleSurfaces([a], liveFor(a))), true);
  assert.equal(w.observe(idleSurfaces([a], liveFor(a))), false);
});

test("falha do Herdr avisa uma vez por episódio e volta a valer após uma conferência boa", () => {
  const w = new IdleWatch();
  assert.equal(w.fail(), true);
  assert.equal(w.fail(), false);
  assert.equal(w.fail(), false);
  w.observe([]);
  assert.equal(w.fail(), true);
  w.reset();
  assert.equal(w.fail(), true);
});

test("idleReport lista candidatas e o motivo de cada não candidata, em ordem estável", () => {
  const ok = task({ task_id: "t-ok" });
  const run = task({ task_id: "t-run", status: "running", notified: false });
  const failed = task({ task_id: "t-fail", status: "failed" });
  const tasks = [failed, run, ok];
  const rep = idleReport(tasks, liveFor(ok));
  assert.deepEqual(rep.eligible, ["t-ok"]);
  assert.deepEqual(rep.not_eligible.map((x) => x.task_id), ["t-fail", "t-run"]);
  assert.match(rep.not_eligible[1].reason, /em andamento/);
  assert.match(rep.not_eligible[0].reason, /failed/);
});

test("aviso de ociosas lista só as candidatas, sem o registro morto (ruído removido)", async () => {
  const { idleNoticeFor } = await import("../src/index.ts");
  const msg = idleNoticeFor([{ task_id: "t-a", project_id: "p" }]);
  assert.match(msg, /com aba aberta \(1\): t-a \(/);
  assert.match(msg, /feche com orch_close/);
  assert.doesNotMatch(msg, /Não são candidatas|tab ou pane/);
});

test("orch_close com pane ausente não fecha nada e não diz que fechou (#62)", async () => {
  const { makeHarness } = await import("./fakes.ts");
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  h.herdr.panesList = [];
  h.herdr.calls = [];
  const out = await h.orch.closeOutcome(t.task_id);
  assert.equal(out.closed, false);
  assert.match(out.reason ?? "", /nada foi fechado/);
  assert.equal(h.herdr.calls.some((c) => c.op === "closeTab"), false, "nenhuma tab foi fechada");
});

test("env de prazo inválida cai no padrão, nunca vira NaN (revisão da #85)", async () => {
  const { envPositive } = await import("../src/index.ts");
  assert.equal(envPositive(undefined, 60_000), 60_000);
  assert.equal(envPositive("abc", 60_000), 60_000);
  assert.equal(envPositive("0", 60_000), 60_000);
  assert.equal(envPositive("-5", 60_000), 60_000);
  assert.equal(envPositive("2", 60_000), 2);
});

test("registro morto só é limpo com aba e pane ausentes e o Herdr respondendo (revisão da #93)", () => {
  const morta = task({ task_id: "t-morta", status: "done", tab_id: "w1:t9", pane_id: "w1:p9", notified: true });
  const ativa = task({ task_id: "t-ativa", status: "running" as TaskRecord["status"], tab_id: "w1:t8", pane_id: "w1:p8" });
  const pane = (pane_id: string) => ({ pane_id, terminal_id: "x", cwd: null, agent: null, agent_status: null });
  // Herdr respondendo, aba e pane ausentes: limpa só a concluída
  assert.deepEqual(deadTabTaskIds([morta, ativa], { tabIds: new Set(["w1:t1"]), panes: [pane("w1:p1")] }), ["t-morta"]);
  // Lista de abas vazia (instante ruim): não limpa nada
  assert.deepEqual(deadTabTaskIds([morta], { tabIds: new Set(), panes: [pane("w1:p1")] }), []);
  // Lista de panes vazia: não limpa nada
  assert.deepEqual(deadTabTaskIds([morta], { tabIds: new Set(["w1:t1"]), panes: [] }), []);
  // Pane ainda existe (aba reindexada): não limpa
  assert.deepEqual(deadTabTaskIds([morta], { tabIds: new Set(["w1:t1"]), panes: [pane("w1:p9")] }), []);
});

test("tarefa entregue por PR não é candidata a fechar: quem fecha é o merge (#pr-merge)", () => {
  const prTask = task({ task_id: "t-pr", source: "https://github.com/MarcosPTProenca/adaptative-learning/pull/171" });
  const reason = whyNotIdle(prTask, liveFor(prTask));
  assert.match(reason ?? "", /aguarda merge da PR/);
});

test("tarefa de issue cuja PR está nos artefatos aguarda o merge, não vira candidata a fechar", () => {
  const t = task({ task_id: "t-iss", source: "https://github.com/o/r/issues/118", artifacts: ["https://github.com/o/r/pull/172"] });
  assert.match(whyNotIdle(t, liveFor(t)) ?? "", /aguarda merge da PR/);
});
