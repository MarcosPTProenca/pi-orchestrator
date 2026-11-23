import { test } from "node:test";
import assert from "node:assert/strict";
import { FixQueue } from "../src/orchestrator/queue.ts";

test("falha de início que esgota as tentativas avisa na hora, mesmo fora da chamada original", async () => {
  const seen: string[] = [];
  const q = new FixQueue<string>(
    1,
    async (item) => {
      if (item === "ruim") throw new Error("pane não abriu");
      return `t-${item}`;
    },
    { maxAttempts: 2, onFailed: (f) => seen.push(`${f.item}:${f.error}`) },
  );
  await q.enqueue(["ruim"]);
  assert.deepEqual(seen, ["ruim:pane não abriu"]);
});

test("setConcurrency aumenta o limite e começa os pendentes; não reduz os em execução", async () => {
  const started: string[] = [];
  const q = new FixQueue<string>(1, async (item) => {
    started.push(item);
    return `t-${item}`;
  });
  await q.enqueue(["a", "b", "c"]);
  assert.deepEqual(started, ["a"]);
  await q.setConcurrency(3);
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.equal(q.runningIds.length, 3);
});

test("setConcurrency fora do intervalo 1..4 é recusado", async () => {
  const q = new FixQueue<string>(1, async (i) => `t-${i}`);
  await assert.rejects(q.setConcurrency(0), /1 a 4/);
  await assert.rejects(q.setConcurrency(5), /1 a 4/);
});

test("failedSince devolve só as falhas depois de um ponto; chamadas seguintes não repetem falhas antigas", async () => {
  const q = new FixQueue<string>(
    1,
    async (item) => {
      if (item.startsWith("ruim")) throw new Error(`falhou ${item}`);
      return `t-${item}`;
    },
    { maxAttempts: 1 },
  );
  await q.enqueue(["ruim1"]);
  const mark = q.failedCount;
  assert.equal(mark, 1);
  await q.enqueue(["ruim2"]);
  assert.deepEqual(
    q.failedSince(mark).map((f) => f.item),
    ["ruim2"],
  );
});
