import { test } from "node:test";
import assert from "node:assert/strict";
import { NoticeBatcher } from "../src/orchestrator/notices.ts";

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number; done: boolean }[] = [];
  let id = 0;
  return {
    sched: {
      set: (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn, id: ++id, done: false };
        timers.push(t);
        return t;
      },
      clear: (h: unknown) => {
        (h as { done: boolean }).done = true;
      },
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => !x.done && x.at <= now)) {
        t.done = true;
        t.fn();
      }
    },
  };
}

type Item = { key: string; text: string };

test("três conclusões em 2 s viram um envio só", () => {
  const clock = fakeClock();
  const sent: Item[][] = [];
  const b = new NoticeBatcher<Item>(5000, (items) => sent.push(items), clock.sched);
  b.push({ key: "t-1:done", text: "a" });
  clock.advance(1000);
  b.push({ key: "t-2:done", text: "b" });
  clock.advance(1000);
  b.push({ key: "t-3:done", text: "c" });
  clock.advance(5000);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].map((i) => i.key),
    ["t-1:done", "t-2:done", "t-3:done"],
  );
});

test("duas conclusões com 10 s de diferença viram dois envios", () => {
  const clock = fakeClock();
  const sent: Item[][] = [];
  const b = new NoticeBatcher<Item>(5000, (items) => sent.push(items), clock.sched);
  b.push({ key: "t-1:done", text: "a" });
  clock.advance(10000);
  b.push({ key: "t-2:done", text: "b" });
  clock.advance(5000);
  assert.equal(sent.length, 2);
});

test("evento repetido na mesma janela não gera segundo item", () => {
  const clock = fakeClock();
  const sent: Item[][] = [];
  const b = new NoticeBatcher<Item>(5000, (items) => sent.push(items), clock.sched);
  b.push({ key: "t-1:done", text: "a" });
  b.push({ key: "t-1:done", text: "a" });
  clock.advance(5000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 1);
});

test("falha no envio tenta de novo e desiste após o limite, sem laço infinito", () => {
  const clock = fakeClock();
  let calls = 0;
  const gaveUp: string[] = [];
  const b = new NoticeBatcher<Item>(
    5000,
    () => {
      calls++;
      throw new Error("pi indisponível");
    },
    clock.sched,
    3,
    (i) => gaveUp.push(i.key),
  );
  b.push({ key: "t-1:done", text: "a" });
  for (let k = 0; k < 10; k++) clock.advance(5000);
  assert.equal(calls, 3);
  assert.deepEqual(gaveUp, ["t-1:done"]);
});

test("drain cancela o envio pendente e devolve o que estava na janela", () => {
  const clock = fakeClock();
  const sent: Item[][] = [];
  const b = new NoticeBatcher<Item>(5000, (items) => sent.push(items), clock.sched);
  b.push({ key: "t-1:done", text: "a" });
  assert.deepEqual(
    b.drain().map((i) => i.key),
    ["t-1:done"],
  );
  clock.advance(10000);
  assert.equal(sent.length, 0);
});
