import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, launchable, nextState } from "../src/orchestrator/plans.ts";

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

const spec = { project_path: "/repo", request: "faça X", objective: "X feito", mode: "direct-pr" as const };

test("item com especificação é lançável só depois que as dependências são concluídas", () => {
  const s = fresh();
  s.create("fase", "Fase", [
    "manual",
    { title: "A", delegate: spec },
    { title: "B", depends_on: ["2"], delegate: spec },
  ]);
  let plan = s.show("fase");
  assert.deepEqual(
    s.ready(plan).map((i) => i.id),
    ["2"],
    "A é lançável; B espera A",
  );
  s.launched("fase", "2", "t-aaaaaaaa");
  plan = s.show("fase");
  assert.deepEqual(s.ready(plan), [], "A em andamento não libera B");
  s.markMerged("t-aaaaaaaa");
  plan = s.show("fase");
  assert.deepEqual(
    s.ready(plan).map((i) => i.id),
    ["3"],
    "A mergeada libera B",
  );
});

test("item só de título nunca é lançável automaticamente", () => {
  const s = fresh();
  s.create("manual", "Manual", ["fazer à mão"]);
  assert.deepEqual(s.ready(s.show("manual")), []);
});

test("dependência de item futuro ou inexistente é recusada", () => {
  const s = fresh();
  assert.throws(
    () => s.create("p1", "P", [{ title: "A", depends_on: ["2"], delegate: spec }, { title: "B" }]),
    /só pode depender de itens anteriores/,
  );
  assert.throws(() => s.create("p2", "P", [{ title: "A", depends_on: ["9"] }]), /não existe/);
});

test("especificação incompleta ou modo inválido é recusado antes de gravar", () => {
  const s = fresh();
  assert.throws(
    () => s.create("p3", "P", [{ title: "A", delegate: { ...spec, objective: "" } }]),
    /delegate.objective obrigatório/,
  );
  assert.throws(
    () => s.create("p4", "P", [{ title: "A", delegate: { ...spec, mode: "yolo" } }]),
    /delegate.mode inválido/,
  );
  assert.deepEqual(s.list(), []);
});

test("item que não pôde ser lançado fica bloqueado com o motivo, e não é lançado de novo", () => {
  const s = fresh();
  s.create("bl", "B", [{ title: "A", delegate: spec }]);
  s.blocked("bl", "1", "modelo indisponível");
  const plan = s.show("bl");
  assert.equal(plan.items[0]!.status, "blocked");
  assert.equal(plan.items[0]!.error, "modelo indisponível");
  assert.deepEqual(s.ready(plan), []);
});

test("plano gravado antes dos campos novos continua legível e sem itens lançáveis", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const old = {
    id: "antigo",
    title: "Antigo",
    created_at: "x",
    items: [{ id: "1", title: "a", status: "pending", task_id: null, pr: null, updated_at: "x" }],
  };
  writeFileSync(join(dir, "antigo.json"), JSON.stringify(old));
  const s = new PlanStore(dir);
  const plan = s.show("antigo");
  assert.deepEqual(plan.items[0]!.depends_on, []);
  assert.equal(plan.items[0]!.delegate, null);
  assert.deepEqual(s.ready(plan), []);
});

test("reserva impede o segundo lançamento do mesmo item", () => {
  const s = fresh();
  s.create("res", "R", [{ title: "A", delegate: spec }]);
  s.reserve("res", "1");
  assert.equal(s.show("res").items[0]!.status, "in_progress");
  assert.throws(() => s.reserve("res", "1"), /não está disponível/);
  assert.deepEqual(s.ready(s.show("res")), [], "item reservado não aparece como lançável");
});

test("item sem PR (modo report) concluído libera os dependentes", () => {
  const s = fresh();
  s.create("rep", "R", [
    { title: "A", delegate: { ...spec, mode: "report" } },
    { title: "B", depends_on: ["1"], delegate: spec },
  ]);
  s.launched("rep", "1", "t-bbbbbbbb");
  assert.deepEqual(s.ready(s.show("rep")), []);
  assert.deepEqual(s.markTaskDone("t-bbbbbbbb"), [{ plan: "rep", item: "1" }]);
  assert.deepEqual(
    s.ready(s.show("rep")).map((i) => i.id),
    ["2"],
  );
});

test("depends_on que não é lista de ids é recusado", () => {
  const s = fresh();
  assert.throws(
    () => s.create("dep", "D", [{ title: "A", depends_on: "1" as unknown as string[] }]),
    /depends_on deve ser lista/,
  );
});

test("plano nasce em rascunho e não lança nada até ser aprovado", () => {
  const s = fresh();
  const plan = s.create("rasc", "R", [{ title: "A", delegate: spec }]);
  assert.equal(plan.state, "draft");
  assert.deepEqual(launchable(s.show("rasc")), []);
  s.act("rasc", "approve");
  assert.deepEqual(
    launchable(s.show("rasc")).map((i) => i.id),
    ["1"],
  );
});

test("transições: aprovar, pausar, retomar e cancelar seguem a tabela; o resto é recusado", () => {
  assert.equal(nextState("draft", "approve"), "approved");
  assert.equal(nextState("approved", "pause"), "paused");
  assert.equal(nextState("paused", "approve"), "approved", "retomar é aprovar de novo");
  assert.equal(nextState("approved", "cancel"), "cancelled");
  assert.throws(() => nextState("draft", "pause"), /não é possível pausar um plano draft/);
  assert.throws(() => nextState("cancelled", "approve"), /não é possível aprovar/);
  assert.throws(() => nextState("completed", "cancel"), /não é possível cancelar/);
});

test("pausado não lança itens; cancelado não reativa", () => {
  const s = fresh();
  s.create("pz", "P", [{ title: "A", delegate: spec }]);
  s.act("pz", "approve");
  s.act("pz", "pause");
  assert.deepEqual(launchable(s.show("pz")), []);
  s.act("pz", "cancel");
  assert.throws(() => s.act("pz", "approve"), /não é possível aprovar um plano cancelled/);
});

test("conclui quando todos os itens estão mergeados ou concluídos, e só se aprovado", () => {
  const s = fresh();
  s.create("cc", "C", [
    { title: "A", delegate: spec },
    { title: "B", depends_on: ["1"], delegate: spec },
  ]);
  assert.equal(s.complete("cc").state, "draft", "rascunho não conclui");
  s.act("cc", "approve");
  s.launched("cc", "1", "t-cccccccc");
  s.launched("cc", "2", "t-dddddddd");
  s.markMerged("t-cccccccc");
  assert.equal(s.complete("cc").state, "approved", "item 2 ainda em andamento");
  s.markMerged("t-dddddddd");
  assert.equal(s.complete("cc").state, "completed");
});

test("plano antigo sem estado vira rascunho: não lança sozinho", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  writeFileSync(
    join(dir, "velho.json"),
    JSON.stringify({
      id: "velho",
      title: "V",
      created_at: "x",
      items: [{ id: "1", title: "a", status: "pending", task_id: null, pr: null, updated_at: "x", delegate: spec }],
    }),
  );
  const plan = new PlanStore(dir).show("velho");
  assert.equal(plan.state, "draft");
  assert.deepEqual(launchable(plan), []);
});
