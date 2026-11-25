import { test } from "node:test";
import assert from "node:assert/strict";
import { NoticeClaims, mergedNoticeKey } from "../src/orchestrator/pr-watch.ts";

const PR = "https://github.com/MarcosPTProenca/pi-orchestrator/pull/190";

// Duas instâncias da extensão no mesmo processo checam a mesma PR quase ao mesmo tempo:
// ambas veem MERGED, e cada uma espera um I/O antes de enviar (closeMerged, advancePlans).
async function merge(checker: (key: string) => boolean, sent: string[], label: string, key: string): Promise<void> {
  await new Promise((r) => setImmediate(r));
  if (!checker(key)) return;
  await new Promise((r) => setImmediate(r));
  sent.push(label);
}

test("duas checagens simultâneas da mesma PR mergeada enviam só uma notificação", async () => {
  const claims = new NoticeClaims();
  const key = mergedNoticeKey("t-77350abd", PR, "sha-1");
  const sent: string[] = [];
  await Promise.all([
    merge((k) => claims.claim(k), sent, "instancia-A", key),
    merge((k) => claims.claim(k), sent, "instancia-B", key),
  ]);
  assert.deepEqual(sent, ["instancia-A"]);
});

test("sem a claim, a mesma corrida envia duas vezes (controle do bug)", async () => {
  const sent: string[] = [];
  await Promise.all([merge(() => true, sent, "instancia-A", "k"), merge(() => true, sent, "instancia-B", "k")]);
  assert.equal(sent.length, 2);
});

test("novo head_sha da mesma PR é um evento distinto", () => {
  const claims = new NoticeClaims();
  assert.equal(claims.claim(mergedNoticeKey("t-1", PR, "sha-1")), true);
  assert.equal(claims.claim(mergedNoticeKey("t-1", PR, "sha-2")), true);
  assert.equal(claims.claim(mergedNoticeKey("t-1", PR, "sha-1")), false);
});

test("tarefas diferentes com a mesma PR não colidem", () => {
  const claims = new NoticeClaims();
  assert.equal(claims.claim(mergedNoticeKey("t-1", PR, "sha-1")), true);
  assert.equal(claims.claim(mergedNoticeKey("t-2", PR, "sha-1")), true);
});

test("release libera nova tentativa quando o envio falha", () => {
  const claims = new NoticeClaims();
  const key = mergedNoticeKey("t-1", PR, "sha-1");
  assert.equal(claims.claim(key), true);
  claims.release(key);
  assert.equal(claims.claim(key), true);
});
