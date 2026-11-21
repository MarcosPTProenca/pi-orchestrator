import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./fakes.ts";
import { maskSecrets } from "../src/logs.ts";

test("orch_logs devolve o trecho recente do painel da tarefa, sem alterar o estado", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const before = JSON.stringify(h.orch.get(t.task_id));
  h.herdr.recentText = "linha 1\nlinha 2 ok";
  assert.equal(await h.orch.logs(t.task_id), "linha 1\nlinha 2 ok");
  assert.equal(JSON.stringify(h.orch.get(t.task_id)), before);
});

test("painel trocado: recusa e não lê nada", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  h.herdr.panesList = h.herdr.panesList.map((p) => (p.pane_id === t.pane_id ? { ...p, terminal_id: "outro" } : p));
  await assert.rejects(h.orch.logs(t.task_id), /trocou de agente/);
  assert.equal(h.herdr.opsOf("readRecent").length, 0);
});

test("painel que sumiu: mensagem clara", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  h.herdr.panesList = [];
  await assert.rejects(h.orch.logs(t.task_id), /não existe mais/);
});

test("segredos conhecidos são mascarados antes de devolver", () => {
  const out = maskSecrets(
    "ok\nghp_abcdefghijklmnopqrstuvwxyz0123456789\nAuthorization: Bearer abc.def.ghi\napi_key=sk-1234567890abcdefghij\nfim",
  );
  assert.doesNotMatch(out, /ghp_abcdef/);
  assert.doesNotMatch(out, /abc\.def\.ghi/);
  assert.doesNotMatch(out, /1234567890abcdef/);
  assert.match(out, /ok\n/);
  assert.match(out, /fim$/);
});
