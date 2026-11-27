import { test } from "node:test";
import assert from "node:assert/strict";
import { capError, launchRoom, maxActiveFrom } from "../src/policy/cap.ts";
import { FixQueue } from "../src/orchestrator/queue.ts";
import { makeHarness, writeReport } from "./fakes.ts";

test("teto padrão é 8 e pode ser trocado por PI_ORCH_MAX_ACTIVE; valor inválido cai no padrão", () => {
  assert.equal(maxActiveFrom(undefined), 8);
  assert.equal(maxActiveFrom("1"), 1);
  assert.equal(maxActiveFrom("10"), 10);
  assert.equal(maxActiveFrom("50"), 50);
  assert.equal(maxActiveFrom("0"), 8);
  assert.equal(maxActiveFrom("abc"), 8);
  assert.equal(maxActiveFrom("51"), 8);
});

test("capError recusa quando o lote estoura, dizendo ativos, teto e o que fazer", () => {
  assert.equal(capError(4, 2, 6), null);
  const msg = capError(5, 3, 6);
  assert.ok(msg);
  assert.match(msg, /5 ativos/);
  assert.match(msg, /teto é 6/);
  assert.match(msg, /[Aa]guarde|cancele|PI_ORCH_MAX_ACTIVE/);
});

test("avanço automático de plano respeita o teto: sem vaga, nada é lançado; com vaga, só a folga", async () => {
  const h = makeHarness();
  const project = h.project;
  await h.orch.delegate({ project_path: project, role: "a", request: "x", objective: "y", mode: "report" });
  await h.orch.delegate({ project_path: project, role: "b", request: "x", objective: "y", mode: "report" });
  assert.equal(launchRoom(2, h.orch.activeCount()), 0, "teto 2 com 2 ativos: sem vaga");
  assert.equal(launchRoom(3, h.orch.activeCount()), 1, "teto 3 com 2 ativos: uma vaga");
  assert.equal(launchRoom(1, h.orch.activeCount()), 0, "ativos acima do teto nunca dão vaga negativa");
});

test("orchestrator conta apenas tarefas em execução para limitar vagas", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await h.orch.delegate({ project_path: h.project, role: "b", request: "x", objective: "y", mode: "report" });
  assert.equal(h.orch.activeCount(), 2);
  writeReport(a.task_dir, a.task_id, { status: "blocked", question: "Usar A ou B?" }, "1");
  await h.orch.refresh(a.task_id);
  assert.equal(h.orch.activeCount(), 1, "blocked aguarda decisão, mas não consome vaga de execução");
  assert.equal(launchRoom(2, h.orch.activeCount()), 1, "item independente pode usar a vaga liberada");
});

test("fila só inicia item quando canStart permite; liberar vaga e pump retoma", async () => {
  let room = 1;
  const started: string[] = [];
  const q = new FixQueue<string>(
    3,
    (item) => {
      started.push(item);
      return Promise.resolve(`t-${item}`);
    },
    { canStart: () => started.length < room },
  );
  await q.enqueue(["a", "b", "c"]);
  assert.deepEqual(started, ["a"]);
  room = 2;
  await q.pump();
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(q.pendingCount, 1);
});
