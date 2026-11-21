import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore } from "../src/plans.ts";

const fresh = () => new PlanStore(mkdtempSync(join(tmpdir(), "plans-")), () => "2026-11-21T00:00:00.000Z");

test("cria plano com itens pendentes numerados e lê de volta", () => {
  const s = fresh();
  const p = s.create("fase-2", "Fase 2", ["Ingestão", "Replay"]);
  assert.deepEqual(
    p.items.map((i) => [i.id, i.title, i.status]),
    [
      ["1", "Ingestão", "pending"],
      ["2", "Replay", "pending"],
    ],
  );
  assert.deepEqual(s.show("fase-2"), p);
  assert.deepEqual(s.list(), ["fase-2"]);
});

test("recusa id inválido, plano sem itens e plano que já existe", () => {
  const s = fresh();
  assert.throws(() => s.create("../fora", "x", ["a"]), /inválido/);
  assert.throws(() => s.create("Maiusculo", "x", ["a"]), /inválido/);
  assert.throws(() => s.create("vazio", "x", []), /sem itens/);
  s.create("ok", "x", ["a"]);
  assert.throws(() => s.create("ok", "x", ["a"]), /já existe/);
});

test("atualiza item: só os campos informados mudam, e status inválido é recusado", () => {
  const s = fresh();
  s.create("p", "P", ["a", "b"]);
  const item = s.update("p", "1", { status: "pr_open", pr: "https://github.com/o/r/pull/9" });
  assert.equal(item.status, "pr_open");
  assert.equal(item.task_id, null);
  assert.equal(s.show("p").items[1].status, "pending", "item 2 intocado");
  assert.throws(() => s.update("p", "1", { status: "feito" as never }), /status inválido/);
  assert.throws(() => s.update("p", "9", { status: "done" }), /não existe/);
});

test("merge da tarefa marca o item como merged, em todos os planos que a citam", () => {
  const s = fresh();
  s.create("p1", "P1", ["a"]);
  s.create("p2", "P2", ["b"]);
  s.update("p1", "1", { task_id: "t-4200aa00", status: "pr_open" });
  s.update("p2", "1", { task_id: "t-9900bb00" });
  assert.deepEqual(s.markMerged("t-4200aa00"), [{ plan: "p1", item: "1" }]);
  assert.equal(s.show("p1").items[0].status, "merged");
  assert.equal(s.show("p2").items[0].status, "pending", "outra tarefa não muda");
  assert.deepEqual(s.markMerged("t-4200aa00"), [], "segunda chamada não toca de novo");
});

test("grava só arquivos .json na pasta do plano, sem temporário sobrando", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const s = new PlanStore(dir, () => "2026-11-21T00:00:00.000Z");
  s.create("p", "P", ["a"]);
  s.update("p", "1", { status: "done" });
  assert.deepEqual(readdirSync(dir), ["p.json"]);
  assert.equal(existsSync(join(dir, "p.json.tmp")), false);
});

test("plano corrompido não impede marcar o item merged nos outros planos", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const s = new PlanStore(dir, () => "2026-11-21T00:00:00.000Z");
  s.create("bom", "Bom", ["a"]);
  s.update("bom", "1", { task_id: "t-10000001" });
  writeFileSync(join(dir, "a-quebrado.json"), "{ nao e json");
  assert.deepEqual(s.markMerged("t-10000001"), [{ plan: "bom", item: "1" }]);
});

test("task_id e pr fora do formato são recusados antes de gravar", () => {
  const s = fresh();
  s.create("p", "P", ["a"]);
  assert.throws(() => s.update("p", "1", { task_id: "qualquer coisa" }), /task_id inválido/);
  assert.throws(() => s.update("p", "1", { pr: "https://exemplo.com/x" }), /pr inválida/);
  assert.equal(s.show("p").items[0].task_id, null, "nada gravado");
  assert.equal(
    s.update("p", "1", { task_id: "t-b60495cd", pr: "https://github.com/o/r/pull/172" }).pr,
    "https://github.com/o/r/pull/172",
  );
});
