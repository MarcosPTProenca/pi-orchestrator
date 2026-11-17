import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";

const HAIKU = "claude-bridge/claude-haiku-5-5";
const LUNA = "openai-codex/gpt-6.1-sol";

async function failed(h: ReturnType<typeof makeHarness>, result: string, model?: string) {
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report", model });
  writeReport(t.task_dir, t.task_id, { status: "failed", result });
  await h.orch.refresh(t.task_id);
  return t;
}

test("falha por cota: relança com outro modelo explícito; a nova tarefa aponta para a anterior", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada no provedor do modelo. Erro: 429 rate limit", HAIKU);
  const neu = await h.orch.relaunch(old.task_id, LUNA);
  assert.equal(neu.model, LUNA);
  assert.equal(h.orch.get(neu.task_id).relaunched_from, old.task_id);
  assert.match(readFileSync(neu.brief_path, "utf8"), new RegExp(`Tentativa anterior \\(${old.task_id}\\)`));
  assert.equal(h.orch.get(old.task_id).status, "failed", "a anterior não muda");
});

test("falha por cota sem modelo informado: recusa e diz o que fazer", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada. Erro: 429", HAIKU);
  await assert.rejects(h.orch.relaunch(old.task_id), /informe o modelo/);
});

test("falha por cota com o mesmo modelo que esgotou: recusa", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada. Erro: 429", HAIKU);
  await assert.rejects(h.orch.relaunch(old.task_id, HAIKU), /esgotou a cota; escolha outro/);
});

test("falha transitória (HTTP 500): relança com o mesmo modelo, sem exigir troca", async () => {
  const h = makeHarness();
  const old = await failed(h, "Encerrou com erro do modelo. Erro: Kiro API error: 500 Internal Server Error", HAIKU);
  const neu = await h.orch.relaunch(old.task_id);
  assert.equal(neu.model, HAIKU);
});

test("tarefa ainda ativa não relança; tarefa não falha não relança", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await assert.rejects(h.orch.relaunch(t.task_id, LUNA), /ainda está ativa/);
});

import { readFileSync } from "node:fs";
