import { test } from "node:test";
import assert from "node:assert/strict";
import { belowFloor, parseVersion } from "../src/herdr.ts";
import { makeHarness } from "./fakes.ts";

test("parseVersion lê a saída de herdr --version e recusa o que não é versão", () => {
  assert.equal(parseVersion("herdr 0.9.1\n"), "0.9.1");
  assert.equal(parseVersion("herdr 0.8.0"), "0.8.0");
  assert.equal(parseVersion("comando inesperado"), null);
});

test("belowFloor compara versões numericamente, com piso 0.8.0", () => {
  assert.equal(belowFloor("0.7.9"), true);
  assert.equal(belowFloor("0.8.0"), false);
  assert.equal(belowFloor("0.9.1"), false);
  assert.equal(belowFloor("0.10.0"), false, "0.10 é maior que 0.8, não comparação de texto");
  assert.equal(belowFloor("0.8.0", "0.9.0"), true, "piso explícito é respeitado");
});

test("presentation spaces: cada tarefa ganha workspace próprio, sem tab compartilhada", async () => {
  const h = makeHarness({ presentationSpaces: true });
  const a = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise A", objective: "Analise A", mode: "report" });
  const b = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise B", objective: "Analise B", mode: "report" });
  assert.equal(h.herdr.opsOf("createWorkspace").length, 2, "um workspace por tarefa");
  assert.equal(h.herdr.opsOf("createTab").length, 0, "não cria tab no workspace do projeto");
  assert.notEqual(a.workspace_id, b.workspace_id);
  assert.equal(a.projected, true);
  assert.equal(a.tab_id.startsWith(`${a.workspace_id}:`), true, "tab é a seeded do próprio workspace");
  const run = h.herdr.opsOf("runInPane")[0].args as { paneId: string; command: string };
  assert.equal(run.paneId, a.pane_id, "worker roda no pane raiz do workspace da tarefa");
  assert.match(run.command, /^env PI_ORCH_ROLE=worker /, "papel vai no comando, já que o workspace não aceita env");
  assert.doesNotMatch(run.command, /HOOK/, "token do webhook não entra no pane");
});

test("presentation spaces: cancel fecha o workspace da tarefa, não só a tab", async () => {
  const h = makeHarness({ presentationSpaces: true });
  const t = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise", objective: "Analise", mode: "report" });
  await h.orch.cancel(t.task_id);
  assert.deepEqual(h.herdr.opsOf("closeWorkspace").map((o) => o.args), [t.workspace_id]);
  assert.equal(h.herdr.opsOf("closeTab").length, 0);
  assert.equal(h.herdr.workspaces.has(t.workspace_id), false);
});

test("presentation spaces: close também fecha o workspace da tarefa", async () => {
  const h = makeHarness({ presentationSpaces: true });
  const t = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise", objective: "Analise", mode: "report" });
  await h.orch.close(t.task_id);
  assert.deepEqual(h.herdr.opsOf("closeWorkspace").map((o) => o.args), [t.workspace_id]);
});

test("presentation spaces: abaixo de 0.8.0 recusa antes de qualquer efeito", async () => {
  const h = makeHarness({ presentationSpaces: true, herdrVersion: "0.7.5" });
  await assert.rejects(
    h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise", objective: "Analise", mode: "report" }),
    /0\.8\.0/,
  );
  assert.equal(h.herdr.opsOf("createWorkspace").length, 0, "nenhum workspace criado");
  assert.equal(h.orch.list().length, 0, "nenhuma tarefa registrada");
});

test("modo padrão continua flat: tab no workspace do projeto, sem marca de projeção", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "investigate", request: "Analise", objective: "Analise", mode: "report" });
  assert.equal(h.herdr.opsOf("createTab").length, 1);
  assert.equal(h.herdr.opsOf("createWorkspace").length, 1);
  assert.ok(!t.projected);
});
