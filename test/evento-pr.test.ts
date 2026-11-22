import { test } from "node:test";
import assert from "node:assert/strict";
import { taskHeadline } from "../src/index.ts";

test("evento de PR traz projeto, tarefa, objetivo e link, não só o número", () => {
  const msg = taskHeadline(
    {
      project_id: "pi-orchestrator",
      task_id: "t-112f2286",
      delegate_input: { objective: "Corrigir aviso de ociosas" },
    },
    "https://github.com/MarcosPTProenca/pi-orchestrator/pull/120",
    "PR #120 mergeada",
  );
  assert.equal(
    msg,
    'PR #120 mergeada (pi-orchestrator, tarefa t-112f2286): https://github.com/MarcosPTProenca/pi-orchestrator/pull/120. Objetivo: "Corrigir aviso de ociosas".',
  );
});

test("objetivo longo é cortado e tarefa sem objetivo não quebra", () => {
  const long = "x".repeat(150);
  const msg = taskHeadline({ project_id: "p", task_id: "t-1", delegate_input: { objective: long } }, "u", "PR #1");
  assert.match(msg, /x{97}\.\.\.\"\./);
  assert.equal(
    taskHeadline({ project_id: "p", task_id: "t-1", delegate_input: null }, "u", "PR #1"),
    "PR #1 (p, tarefa t-1): u.",
  );
});
