import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardPlanStep,
  type PlanFailure,
  PlanFailureWatch,
  planFailureRecord,
  writePlanFailure,
} from "../src/orchestrator/plan-failures.ts";

test("planFailureRecord estrutura o erro e mascara segredos", () => {
  const rec = planFailureRecord(
    "launchReady",
    "plano-1",
    new Error("falha com token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
  );
  assert.equal(rec.where, "launchReady");
  assert.equal(rec.plan_id, "plano-1");
  assert.ok(!rec.error.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
});

test("planFailureRecord aceita valores que não são Error", () => {
  const rec = planFailureRecord("reconcilePlans", null, "texto solto");
  assert.equal(rec.error, "texto solto");
  assert.equal(rec.plan_id, null);
});

test("PlanFailureWatch só avisa na primeira falha da chave até um sucesso", () => {
  const watch = new PlanFailureWatch();
  assert.equal(watch.fail("a"), true);
  assert.equal(watch.fail("a"), false);
  assert.equal(watch.fail("b"), true);
  watch.ok("a");
  assert.equal(watch.fail("a"), true);
});

test("guardPlanStep não propaga erro e avisa uma vez por episódio de falha", async () => {
  const watch = new PlanFailureWatch();
  const notices: string[] = [];
  const failing = (): Promise<void> => Promise.reject(new Error("boom"));
  for (let cycle = 0; cycle < 3; cycle++) {
    await guardPlanStep(watch, "k", "launchReady", "p1", failing, (f) => notices.push(f.error));
  }
  assert.deepEqual(notices, ["boom"]);
});

test("guardPlanStep avisa de novo depois de recuperar e falhar outra vez", async () => {
  const watch = new PlanFailureWatch();
  const notices: string[] = [];
  const onFail = (f: PlanFailure): number => notices.push(f.error);
  await guardPlanStep(watch, "k", "w", null, () => Promise.reject(new Error("1")), onFail);
  await guardPlanStep(watch, "k", "w", null, () => Promise.resolve(), onFail);
  await guardPlanStep(watch, "k", "w", null, () => Promise.reject(new Error("2")), onFail);
  assert.deepEqual(notices, ["1", "2"]);
});

test("loop de polling sobrevive a falha em um plano e continua nos demais", async () => {
  const watch = new PlanFailureWatch();
  const notices: string[] = [];
  const processed: string[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    for (const planId of ["p-ruim", "p-bom"]) {
      await guardPlanStep(
        watch,
        `launchReady:${planId}`,
        "launchReady",
        planId,
        () => {
          if (planId === "p-ruim") throw new Error("plano corrompido");
          processed.push(`${cycle}:${planId}`);
        },
        (f) => notices.push(`${f.plan_id}: ${f.error}`),
      );
    }
  }
  assert.equal(processed.length, 4, "o plano bom roda em todos os ciclos");
  assert.deepEqual(notices, ["p-ruim: plano corrompido"]);
});

test("writePlanFailure grava uma linha JSON por registro", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-failures-"));
  const file = join(dir, "plan-failures.log");
  writePlanFailure(file, planFailureRecord("advancePlans", "p1", new Error("x")));
  writePlanFailure(file, planFailureRecord("advancePlans", "p1", new Error("y")));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[1]) as PlanFailure).error, "y");
});

test("extensão não suprime falha de launchReady, advancePlans ou reconcilePlans", () => {
  const source = readFileSync(new URL("../src/orchestrator/extension.ts", import.meta.url), "utf8");
  for (const call of ["launchReady(planId).catch", "advancePlans().catch", "reconcilePlans().catch"]) {
    assert.ok(!source.includes(call), `supressão silenciosa ainda presente: ${call}`);
  }
  assert.ok(!source.includes("} catch {\n          continue;"), "catch silencioso por item ainda presente");
});
