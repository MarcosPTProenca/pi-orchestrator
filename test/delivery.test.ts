import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryFromFix } from "../src/orchestrator/delivery.ts";
import { PlanStore, launchable, trackedItems } from "../src/orchestrator/plans.ts";

const PR_A = "https://github.com/o/r/pull/10";
const T_A = "t-aaaaaaaa";
const T_B = "t-bbbbbbbb";
const dir = () => mkdtempSync(join(tmpdir(), "t147-"));
const delegate = { project_path: "/tmp/repo", request: "faça", objective: "obj", mode: "direct-pr" };

function planAB(store: PlanStore): void {
  store.create("entrega", "Entrega", [
    { title: "A", delegate },
    { title: "B", depends_on: ["1"], delegate },
  ]);
  store.act("entrega", "approve");
}

test("fix loop vira contrato de eventos sem decidir nada novo", () => {
  const sha = "abc123";
  assert.deepEqual(deliveryFromFix({ kind: "request_review", head_sha: sha }, T_A), {
    name: "review_pending",
    task_id: T_A,
    head_sha: sha,
  });
  assert.equal(deliveryFromFix({ kind: "send_findings", head_sha: sha, key: "k" }, T_A)?.name, "changes_required");
  assert.equal(deliveryFromFix({ kind: "send_ci_fix", head_sha: sha, key: "k" }, T_A)?.name, "changes_required");
  assert.equal(deliveryFromFix({ kind: "approved", head_sha: sha }, T_A)?.name, "merge_eligible");
  assert.deepEqual(deliveryFromFix({ kind: "blocked", reason: "limite" }, T_A), {
    name: "blocked",
    task_id: T_A,
    reason: "limite",
  });
  assert.equal(deliveryFromFix({ kind: "none" }, T_A), null);
});

test("PR A aprovada mas não mergeada não inicia B; merge de A inicia B uma única vez", () => {
  const store = new PlanStore(dir(), () => "2026-11-23T00:00:00.000Z");
  planAB(store);
  const [a] = launchable(store.show("entrega"));
  assert.equal(a.id, "1");
  store.reserve("entrega", "1");
  store.launched("entrega", "1", T_A);
  store.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_A, head_sha: "h1" });
  store.recordDelivery({ name: "merge_eligible", task_id: T_A, head_sha: "h1" });
  assert.deepEqual(launchable(store.show("entrega")), [], "A aprovada não mergeada: B não sai");

  assert.deepEqual(store.markMerged(T_A), [{ plan: "entrega", item: "1" }]);
  const ready = launchable(store.show("entrega"));
  assert.deepEqual(
    ready.map((i) => i.id),
    ["2"],
  );
  store.reserve("entrega", "2");
  assert.deepEqual(launchable(store.show("entrega")), [], "B reservada: não é lançada de novo");
  assert.deepEqual(store.markMerged(T_A), [], "segundo merge não reabre nada");
  assert.throws(() => store.reserve("entrega", "2"), /não está disponível/);
});

test("pr_open é preservada no reinício: reconcile enxerga a PR de quem ficou offline", () => {
  const d = dir();
  const first = new PlanStore(d, () => "2026-11-23T00:00:00.000Z");
  planAB(first);
  first.reserve("entrega", "1");
  first.launched("entrega", "1", T_A);
  first.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_A, head_sha: "h1" });

  const restarted = new PlanStore(d);
  const tracked = trackedItems(restarted.show("entrega"));
  assert.deepEqual(
    tracked.map((i) => [i.id, i.status, i.pr]),
    [["1", "pr_open", PR_A]],
  );
  assert.equal(tracked[0].delivery?.phase, "pr_open");
  assert.equal(tracked[0].delivery?.head_sha, "h1");
});

test("trackedItems ignora pending e merged", () => {
  const store = new PlanStore(dir(), () => "2026-11-23T00:00:00.000Z");
  planAB(store);
  assert.deepEqual(trackedItems(store.show("entrega")), []);
  store.reserve("entrega", "1");
  store.launched("entrega", "1", T_A);
  store.markMerged(T_A);
  assert.deepEqual(trackedItems(store.show("entrega")), []);
});

test("recordDelivery com fase igual não regrava o plano (sem escrita a cada ciclo)", () => {
  const d = dir();
  const store = new PlanStore(d, () => "2026-11-23T00:00:00.000Z");
  planAB(store);
  store.reserve("entrega", "1");
  store.launched("entrega", "1", T_A);
  store.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_A, head_sha: "h1" });
  const before = readFileSync(join(d, "entrega.json"), "utf8");
  store.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_A, head_sha: "h1" });
  assert.equal(readFileSync(join(d, "entrega.json"), "utf8"), before);
});

test("pausa e cancelamento bloqueiam fix da tarefa; plano aprovado não", () => {
  const store = new PlanStore(dir(), () => "2026-11-23T00:00:00.000Z");
  planAB(store);
  store.reserve("entrega", "1");
  store.launched("entrega", "1", T_A);
  assert.equal(store.pausedFor(T_A), false, "aprovado: fix segue");
  store.act("entrega", "pause");
  assert.equal(store.pausedFor(T_A), true, "pausado: fix para");
  assert.equal(store.pausedFor(T_B), false, "tarefa de fora do plano não é afetada");
  store.act("entrega", "cancel");
  assert.equal(store.pausedFor(T_A), true, "cancelado: fix para");
});
