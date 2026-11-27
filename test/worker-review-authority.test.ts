import { test } from "node:test";
import assert from "node:assert/strict";
import { workerToolSet } from "../src/shared/worker-tools.ts";
import { asWorker, loadWorker } from "./worker-harness.ts";

async function toolCall(input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
  return (await loadWorker().handlers.tool_call(input)) as { block?: boolean; reason?: string } | undefined;
}

// keep: limite aceito (VISION §1 e §3, mesmo usuário de SO); prova o que a Factory controla, sem tool de veredito e sem bash no store.

test("nenhum modo expõe ferramenta de veredito de review ao worker", () => {
  for (const mode of ["report", "design", "direct-pr"] as const) {
    assert.ok(!workerToolSet(mode, []).includes("orch_review_verdict"), `${mode} ainda expõe orch_review_verdict`);
  }
});

test("a extensão do worker não registra ferramenta de veredito de review", async () => {
  await asWorker({ task_id: "t-review01", task_dir: process.cwd() }, async (w) => {
    assert.equal(w.tools.orch_review_verdict, undefined);
    assert.ok(w.tools.orch_report, "controle: contratos orch_* continuam");
  });
});

test("bash do worker que cita o store de review é bloqueado", async () => {
  await asWorker({ task_id: "t-review02", task_dir: process.cwd() }, async () => {
    const verdict = await toolCall({
      toolName: "bash",
      input: { command: "cp forjado.json ~/.pi/orchestrator/reviews/o/r/pr1/abc.json" },
    });
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /reviews/);
  });
});

test("bash comum do worker, incluindo a pasta da tarefa, continua liberado", async () => {
  await asWorker({ task_id: "t-review03", task_dir: process.cwd() }, async () => {
    const r = await toolCall({
      toolName: "bash",
      input: { command: "ls $PI_ORCH_TASK_DIR && git status --porcelain" },
    });
    assert.notEqual(r?.block, true);
  });
});
