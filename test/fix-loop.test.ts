import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixLoopStore, step, freshRecord, type FixEvent } from "../src/orchestrator/fix-loop.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const T = "t-1";
const NOW = "2026-11-23T00:00:00.000Z";

const fresh = () => freshRecord(T, NOW);
const run = (events: FixEvent[], max = 2) => {
  let rec = fresh();
  const actions = [];
  for (const e of events) {
    const out = step(rec, e, max, NOW);
    rec = out.record;
    actions.push(out.action);
  }
  return { rec, actions };
};

test("approve 1ª rodada: revisão do head A aprova e nada é reenviado", () => {
  const { rec, actions } = run([
    { type: "head", head_sha: A },
    { type: "review", head_sha: A, verdict: "approve", blocking: 0 },
  ]);
  assert.equal(rec.state, "REVIEW_APPROVED");
  assert.deepEqual(actions[1], { kind: "approved", head_sha: A });
});

test("request_changes com achados envia ao mesmo worker uma vez; webhook duplicado não reenvia", () => {
  const ev: FixEvent = { type: "review", head_sha: A, verdict: "request_changes", blocking: 2 };
  const { rec, actions } = run([{ type: "head", head_sha: A }, ev, ev]);
  assert.equal(rec.state, "FIXING");
  assert.equal(rec.attempts, 1);
  assert.deepEqual(actions[1], { kind: "send_findings", head_sha: A, key: `${T}|${A}|review` });
  assert.deepEqual(actions[2], { kind: "none" });
});

test("worker empurra B: review novo só para B; aprovação antiga de A não autoriza B", () => {
  const { rec, actions } = run([
    { type: "head", head_sha: A },
    { type: "review", head_sha: A, verdict: "request_changes", blocking: 1 },
    { type: "head", head_sha: B },
    { type: "review", head_sha: A, verdict: "approve", blocking: 0 },
    { type: "review", head_sha: B, verdict: "approve", blocking: 0 },
  ]);
  assert.deepEqual(actions[2], { kind: "request_review", head_sha: B });
  assert.deepEqual(actions[3], { kind: "none" }, "revisão de A é stale após commit B");
  assert.equal(actions[4].kind, "approved");
  assert.equal(rec.state, "REVIEW_APPROVED");
});

test("CI vermelho com código envia correção; mesmo head não repete a instrução", () => {
  const ci: FixEvent = { type: "ci_red", head_sha: A, checks: ["test"] };
  const { actions } = run([{ type: "head", head_sha: A }, ci, ci]);
  assert.deepEqual(actions[1], { kind: "send_ci_fix", head_sha: A, key: `${T}|${A}|ci` });
  assert.deepEqual(actions[2], { kind: "none" });
});

test("novo head reabre o envio de CI para o mesmo tipo de falha", () => {
  const { actions } = run([
    { type: "head", head_sha: A },
    { type: "ci_red", head_sha: A, checks: ["test"] },
    { type: "head", head_sha: B },
    { type: "ci_red", head_sha: B, checks: ["test"] },
  ]);
  assert.equal(actions[3].kind, "send_ci_fix");
});

test("limite de ciclos bloqueia a PR entre heads e não envia mais nada", () => {
  const C = "c".repeat(40);
  const { rec, actions } = run(
    [
      { type: "head", head_sha: A },
      { type: "review", head_sha: A, verdict: "request_changes", blocking: 1 },
      { type: "head", head_sha: B },
      { type: "ci_red", head_sha: B, checks: ["test"] },
      { type: "head", head_sha: C },
      { type: "review", head_sha: C, verdict: "request_changes", blocking: 1 },
      { type: "ci_red", head_sha: C, checks: ["test"] },
    ],
    2,
  );
  assert.equal(rec.state, "BLOCKED");
  assert.equal(actions[3].kind, "send_ci_fix");
  assert.equal(actions[5].kind, "blocked");
  assert.match((actions[5] as { reason: string }).reason, /2 ciclos/);
  assert.deepEqual(actions[6], { kind: "none" });
});

test("CI repetido no mesmo head não consome ciclo nem gera nova instrução", () => {
  const ci: FixEvent = { type: "ci_red", head_sha: A, checks: ["test"] };
  const { rec } = run([{ type: "head", head_sha: A }, ci, ci, ci], 1);
  assert.equal(rec.attempts, 1);
  assert.notEqual(rec.state, "BLOCKED");
});

test("revogação interrompe ciclos: nenhum evento depois dela gera ação", () => {
  const { rec, actions } = run([
    { type: "head", head_sha: A },
    { type: "revoke", reason: "autorização retirada" },
    { type: "ci_red", head_sha: A, checks: ["test"] },
    { type: "review", head_sha: A, verdict: "approve", blocking: 0 },
  ]);
  assert.equal(rec.state, "REVOKED");
  assert.equal(actions[2].kind, "none");
  assert.equal(actions[3].kind, "none");
});

test("store persiste: reinício com o mesmo evento não reenvia (dedupe e limite sobrevivem)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fix-loop-")), "fix-loop.json");
  const ci: FixEvent = { type: "ci_red", head_sha: A, checks: ["test"] };
  const first = new FixLoopStore(file, { maxAttempts: 2, now: () => NOW });
  first.apply(T, { type: "head", head_sha: A });
  assert.equal(first.apply(T, ci).action.kind, "send_ci_fix");
  const restarted = new FixLoopStore(file, { maxAttempts: 2, now: () => NOW });
  assert.equal(restarted.apply(T, ci).action.kind, "none");
  assert.equal(restarted.get(T)?.attempts, 1);
});

test("restore desfaz o registro quando o envio falha, permitindo nova tentativa", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fix-loop-")), "fix-loop.json");
  const store = new FixLoopStore(file, { maxAttempts: 2, now: () => NOW });
  store.apply(T, { type: "head", head_sha: A });
  const ci: FixEvent = { type: "ci_red", head_sha: A, checks: ["test"] };
  const { previous } = store.apply(T, ci);
  store.restore(T, previous);
  assert.equal(store.apply(T, ci).action.kind, "send_ci_fix");
  assert.equal(store.get(T)?.attempts, 1);
});
