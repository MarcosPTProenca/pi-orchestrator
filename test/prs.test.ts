import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRedPrs, fixInputFor, ghEnvFor } from "../src/prs.ts";
import { FixQueue } from "../src/queue.ts";

const sample = [
  { number: 137, title: "feat: rota", headRefName: "fm/al-issue-63-q1", url: "https://github.com/MarcosPTProenca/adaptative-learning/pull/137",
    statusCheckRollup: [{ name: "check", conclusion: "SUCCESS" }, { name: "quality", conclusion: "FAILURE" }] },
  { number: 138, title: "verde", headRefName: "x", url: "u", statusCheckRollup: [{ name: "check", conclusion: "SUCCESS" }] },
  { number: 139, title: "status antigo", headRefName: "y", url: "u", statusCheckRollup: [{ context: "ci", state: "ERROR" }, { name: "pending", conclusion: null }] },
];

test("parseRedPrs mantém só PRs com check falhando e lista os nomes", () => {
  const red = parseRedPrs(sample);
  assert.deepEqual(red.map((p) => p.number), [137, 139]);
  assert.deepEqual(red[0].failing, ["quality"]);
  assert.deepEqual(red[1].failing, ["ci"]);
});

test("fixInputFor monta intent, spec fixa e modo direct-pr na branch da PR", () => {
  const [pr] = parseRedPrs(sample);
  const input = fixInputFor(pr, "/repo", "claude-bridge/claude-haiku-5-5");
  assert.equal(input.mode, "direct-pr");
  assert.equal(input.branch, "fm/al-issue-63-q1");
  assert.equal(input.model, "claude-bridge/claude-haiku-5-5");
  assert.match(input.intent, /PR #137/);
  assert.match(input.intent, /quality/);
  assert.match(input.spec, /Não atualize baselines/);
  assert.match(input.spec, /gh pr checks 137/);
});

test("ghEnvFor não usa a credencial pessoal em repositório de outro dono", () => {
  const base = { PATH: "/x" } as NodeJS.ProcessEnv;
  assert.equal(ghEnvFor("git@github.com:outra-org/repo.git", base).GH_TOKEN, undefined);
});

test("FixQueue mantém no máximo N em execução e avança quando um termina", async () => {
  const started: string[] = [];
  const q = new FixQueue<string>(2, async (item) => {
    started.push(item);
    return `t-${item}`;
  });
  await q.enqueue(["a", "b", "c", "d", "e"]);
  assert.deepEqual(started, ["a", "b"], "só dois em paralelo");
  assert.equal(q.pendingCount, 3);
  await q.settle("t-a");
  assert.deepEqual(started, ["a", "b", "c"]);
  await q.settle("t-x-fora-da-fila");
  assert.equal(q.pendingCount, 2, "tarefa fora da fila não libera slot");
  await q.settle("t-b");
  await q.settle("t-c");
  await q.settle("t-d");
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
});

test("FixQueue: falha ao iniciar um item não trava a fila", async () => {
  const q = new FixQueue<string>(2, async (item) => {
    if (item === "bad") throw new Error("delegação recusada");
    return `t-${item}`;
  });
  await q.enqueue(["bad", "a", "b"]);
  assert.equal(q.failed.length, 1);
  assert.deepEqual(q.runningIds.sort(), ["t-a", "t-b"]);
});
