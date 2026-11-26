import { test } from "node:test";
import assert from "node:assert/strict";
import { StallWatchdog } from "../src/worker/stall-watchdog.ts";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function make(idleMs = 1000) {
  const clock = fakeClock();
  let stalls = 0;
  const wd = new StallWatchdog({
    idleMs,
    onStall: () => stalls++,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { wd, clock, stalls: () => stalls };
}

test("dispara após idleMs sem progresso depois de start", () => {
  const { wd, clock, stalls } = make(1000);
  wd.start();
  clock.advance(999);
  assert.equal(stalls(), 0);
  clock.advance(1);
  assert.equal(stalls(), 1);
});

test("progresso reinicia a contagem e impede disparo", () => {
  const { wd, clock, stalls } = make(1000);
  wd.start();
  clock.advance(900);
  wd.progress();
  clock.advance(900);
  assert.equal(stalls(), 0, "progresso antes do limite deve adiar o disparo");
  clock.advance(100);
  assert.equal(stalls(), 1);
});

test("progresso sem start não arma o watchdog", () => {
  const { wd, clock, stalls } = make(1000);
  wd.progress();
  clock.advance(5000);
  assert.equal(stalls(), 0);
});

test("pause durante ferramenta impede disparo; start rearma", () => {
  const { wd, clock, stalls } = make(1000);
  wd.start();
  clock.advance(500);
  wd.pause();
  clock.advance(60_000);
  assert.equal(stalls(), 0, "bash longo não é stall");
  wd.start();
  clock.advance(1000);
  assert.equal(stalls(), 1);
});

test("depois de disparar, não dispara de novo sem novo start", () => {
  const { wd, clock, stalls } = make(1000);
  wd.start();
  clock.advance(1000);
  clock.advance(10_000);
  assert.equal(stalls(), 1);
  assert.equal(clock.pending(), 0);
});

test("pause cancela o timer pendente", () => {
  const { wd, clock } = make(1000);
  wd.start();
  wd.pause();
  assert.equal(clock.pending(), 0);
});
