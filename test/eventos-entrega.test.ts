import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, reopenHarness as reabrir, writeReport } from "./fakes.ts";
import type { State, Store } from "../src/shared/store.ts";

const ids = (evs: { task_id: string; status: string }[]) => evs.map((e) => `${e.task_id}:${e.status}`);

test("aviso pego e não entregue antes de queda do processo volta no próximo início", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  assert.equal((await h.orch.noticeFor(t.task_id))?.status, "done", "pego pelo primeiro caminho");
  assert.deepEqual(ids(await reabrir(h).pendingNotices()), [`${t.task_id}:done`], "conclusão não se perde");
});

test("aviso confirmado como entregue não volta no reinício", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  await h.orch.noticeFor(t.task_id);
  h.orch.markDelivered(t.task_id, "done");
  assert.deepEqual(await reabrir(h).pendingNotices(), [], "entregue não reaparece");
});

test("pergunta bloqueada com queda antes da entrega: volta uma vez, e não volta depois de entregue", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Usar A ou B?" }, "1");
  await h.orch.refresh(t.task_id);
  assert.equal((await h.orch.noticeFor(t.task_id))?.status, "blocked");
  const primeiro = reabrir(h);
  assert.deepEqual(ids(await primeiro.pendingNotices()), [`${t.task_id}:blocked`], "volta após queda");
  primeiro.markDelivered(t.task_id, "blocked");
  assert.deepEqual(await reabrir(h).pendingNotices(), [], "após entrega, reinício não repete a pergunta");
  assert.equal(reabrir(h).get(t.task_id).status, "blocked", "continua bloqueada até resposta");
});

test("pendente obsoleto (pergunta já respondida e nova conclusão) não é reenviado: só a conclusão", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Usar A ou B?" }, "1");
  await h.orch.refresh(t.task_id);
  await h.orch.noticeFor(t.task_id);
  writeReport(t.task_dir, t.task_id, { status: "done", result: "usei A" }, "2");
  await h.orch.refresh(t.task_id);
  assert.deepEqual(ids(await reabrir(h).pendingNotices()), [`${t.task_id}:done`], "bloqueio antigo não volta");
});

test("30 ciclos de varredura sem mudança: nenhum aviso novo, nenhum pendente criado", async () => {
  const h = makeHarness();
  const running = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
  });
  const done = await h.orch.delegate({
    project_path: h.project,
    role: "b",
    request: "x",
    objective: "y",
    mode: "report",
  });
  writeReport(done.task_dir, done.task_id, { status: "done", result: "ok" });
  await h.orch.sweep();
  h.orch.markDelivered(done.task_id, "done");
  let avisos = 0;
  for (let i = 0; i < 30; i++) avisos += (await h.orch.sweep()).length + (await h.orch.pendingNotices()).length;
  assert.equal(avisos, 0, "zero avisos em 30 ciclos");
  assert.equal(h.orch.get(running.task_id).delivery_pending ?? null, null);
});

test("dedupe entre sessões: aviso já tomado por outra sessão não sai de novo, mesmo se ela ganhar a trava antes", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  const store = (h.orch as unknown as { d: { store: Store } }).d.store;
  const realMutate = store.mutate.bind(store);
  let raced = false;
  store.mutate = <T>(fn: (s: State) => T): T => {
    if (!raced) {
      raced = true;
      realMutate((s) => {
        const x = s.tasks[t.task_id];
        if (x) x.notified = true;
      });
    }
    return realMutate(fn);
  };
  assert.equal(h.orch.takeNotice(t.task_id), false, "outra sessão pegou primeiro: esta não envia de novo");
});
