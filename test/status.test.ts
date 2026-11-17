import { test } from "node:test";
import assert from "node:assert/strict";
import { ageText, buildStatus, DEFAULT_OLD_HOURS } from "../src/status.ts";
import type { TaskRecord } from "../src/contract.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const t = (over: Record<string, unknown>) => ({ project_path: "/x", worker_id: "w", workspace_id: "", tab_id: "", terminal_id: "", error: null, last_report_key: null, notified: false, task_dir: "", brief_path: "", prompt_attempts: 1, worker_started: true,
  task_id: "t-1", project_id: "alpha", role: "a", status: "running", model: null, pane_id: "", question: null,
  deadline_at: null, verification: null, result: null, artifacts: [] as string[],
  created_at: "2026-11-17T11:00:00Z", updated_at: "2026-11-17T11:30:00Z", ...over,
}) as unknown as TaskRecord;

test("ageText escreve a idade de forma curta", () => {
  assert.equal(ageText(45_000), "45 s");
  assert.equal(ageText(12 * 60_000), "12 min");
  assert.equal(ageText((3 * 60 + 5) * 60_000), "3 h 5 min");
  assert.equal(ageText(50 * 60 * 60_000), "2 d 2 h");
});

test("agrupa por projeto, com idade e resumo curto", () => {
  const out = buildStatus([t({ task_id: "t-1", project_id: "alpha" }), t({ task_id: "t-2", project_id: "beta", status: "done", result: "x".repeat(500), artifacts: ["https://github.com/o/r/pull/3"], updated_at: "2026-11-17T11:50:00Z" })], NOW, {});
  assert.deepEqual(out.map((g) => g.project_id), ["alpha", "beta"]);
  assert.equal(out[0].tasks[0].age, "1 h 0 min");
  assert.equal(out[1].tasks[0].result!.length <= 200, true);
  assert.deepEqual(out[1].tasks[0].artifacts, ["https://github.com/o/r/pull/3"]);
});

test("por padrão esconde canceladas e terminais antigas; all mostra tudo", () => {
  const old = t({ task_id: "t-old", status: "done", updated_at: "2026-11-15T12:00:00Z" });
  const cancelled = t({ task_id: "t-c", status: "cancelled" });
  const recent = t({ task_id: "t-r", status: "done", updated_at: "2026-11-17T11:50:00Z" });
  const ids = (o: ReturnType<typeof buildStatus>) => o.flatMap((g) => g.tasks.map((x) => x.task_id)).sort();
  assert.deepEqual(ids(buildStatus([old, cancelled, recent], NOW, {})), ["t-r"]);
  assert.deepEqual(ids(buildStatus([old, cancelled, recent], NOW, { all: true })), ["t-c", "t-old", "t-r"].sort());
  assert.equal(DEFAULT_OLD_HOURS, 24);
});

test("tarefa ativa nunca some, mesmo antiga", () => {
  const ativa = t({ task_id: "t-a", status: "blocked", created_at: "2026-11-10T00:00:00Z", question: "A ou B?" });
  const out = buildStatus([ativa], NOW, {});
  assert.equal(out[0].tasks[0].question, "A ou B?");
});

test("orch_status mostra o total de tokens quando medido, senão null", () => {
  const withUsage = t({ task_id: "t-u", status: "done", updated_at: "2026-11-17T11:50:00Z", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 } });
  const without = t({ task_id: "t-n", status: "running" });
  const rows = buildStatus([withUsage, without], NOW, {}).flatMap((g) => g.tasks);
  assert.equal(rows.find((r) => r.task_id === "t-u")?.tokens, 10);
  assert.equal(rows.find((r) => r.task_id === "t-n")?.tokens, null);
});
