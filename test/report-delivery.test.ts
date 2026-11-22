import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport } from "../src/contract.ts";
import { fallbackReportFor } from "../src/fallback.ts";
import workerExtension from "../src/worker-ext.ts";
import { makeHarness, writeReport } from "./fakes.ts";

async function started(h: ReturnType<typeof makeHarness>) {
  return h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
}

function markIdle(h: ReturnType<typeof makeHarness>, paneId: string) {
  h.herdr.panesList = h.herdr.panesList.map((p) =>
    p.pane_id === paneId ? { ...p, agent: "pi", agent_status: "idle" } : p,
  );
}

test("relatório sem task_id é diagnosticado como tal, não como de outra tarefa", () => {
  assert.throws(() => validateReport({ status: "done", result: "x" }, "t1"), /relatório sem task_id \(esperado t1\)/);
});

test("relatório inválido não derruba tarefa ativa; o relatório válido seguinte conclui sem falha intermediária", async () => {
  const h = makeHarness();
  const t = await started(h);
  writeFileSync(join(t.task_dir, "report.json"), JSON.stringify({ status: "done", result: "sem id" }));
  assert.equal(await h.orch.refresh(t.task_id), null);
  assert.equal(h.orch.get(t.task_id).status, "running");
  assert.match(h.orch.get(t.task_id).error ?? "", /sem task_id/);
  writeReport(t.task_dir, t.task_id, { status: "done", result: "corrigido" }, "2");
  assert.equal((await h.orch.refresh(t.task_id))?.status, "done");
  assert.equal(h.orch.get(t.task_id).error, null);
});

test("continuação que encerra sem orch_report mantém o resultado anterior", async () => {
  const h = makeHarness();
  const t = await started(h);
  markIdle(h, t.pane_id);
  writeReport(t.task_dir, t.task_id, { status: "done", result: "revisado" }, "1");
  await h.orch.refresh(t.task_id);
  await h.orch.send(t.task_id, "corrija a revisão");
  writeFileSync(join(t.task_dir, "report.json"), JSON.stringify(fallbackReportFor(t.task_id, [], "2")));
  await h.orch.refresh(t.task_id);
  const after = h.orch.get(t.task_id);
  assert.equal(after.status, "done");
  assert.equal(after.result, "revisado");
  assert.match(after.error ?? "", /resultado anterior mantido/);
});

test("primeira execução sem orch_report continua falha", async () => {
  const h = makeHarness();
  const t = await started(h);
  writeFileSync(join(t.task_dir, "report.json"), JSON.stringify(fallbackReportFor(t.task_id, [], "1")));
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "failed");
  assert.equal(h.orch.get(t.task_id).result, "Encerrou o turno sem chamar orch_report.");
});

function withWorkerEnv(taskId: string, dir: string, fn: (handlers: Record<string, Function>) => Promise<void>) {
  return async () => {
    const previous = { ...process.env };
    try {
      process.env.PI_ORCH_ROLE = "worker";
      process.env.PI_ORCH_TASK_ID = taskId;
      process.env.PI_ORCH_TASK_DIR = dir;
      delete process.env.PI_ORCH_HOOK_URL;
      delete process.env.PI_ORCH_HOOK_TOKEN;
      const handlers: Record<string, Function> = {};
      workerExtension({
        on: (name: string, f: Function) => {
          handlers[name] = f;
        },
        registerTool: () => {},
        registerEntryRenderer: () => {},
        appendEntry: () => {},
      } as never);
      await fn(handlers);
    } finally {
      process.env = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "fim de turno com relatório inválido: guarda o arquivo de lado e grava falha com o motivo",
  withWorkerEnv("t-end1", mkdtempSync(join(tmpdir(), "orch-end-")), async (handlers) => {
    const dir = process.env.PI_ORCH_TASK_DIR as string;
    writeFileSync(join(dir, "report.json"), JSON.stringify({ status: "done", result: "sem id" }));
    await handlers.agent_end({ messages: [] }, { sessionManager: { getEntries: () => [] } });
    await handlers.agent_before_settle({ entries: [], continue: false, context: {}, outcome: {} }, {});
    await handlers.agent_end({ messages: [] }, { sessionManager: { getEntries: () => [] } });
    const r = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(r.task_id, "t-end1");
    assert.equal(r.status, "failed");
    assert.match(r.result, /relatório inválido/);
    assert.ok(
      readdirSync(dir).some((n) => /^report-invalid-/.test(n)),
      "relatório inválido preservado",
    );
  }),
);

test(
  "fim de turno com relatório válido já escrito não é sobrescrito",
  withWorkerEnv("t-end2", mkdtempSync(join(tmpdir(), "orch-end-")), async (handlers) => {
    const dir = process.env.PI_ORCH_TASK_DIR as string;
    writeReport(dir, "t-end2", { status: "done", result: "ok" });
    await handlers.agent_end({ messages: [] }, { sessionManager: { getEntries: () => [] } });
    assert.equal(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).status, "done");
  }),
);
