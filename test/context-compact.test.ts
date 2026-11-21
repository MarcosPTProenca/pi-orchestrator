import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";
import { tailLog } from "../src/logs.ts";

test("orch_inbox sem consumo: lê o aviso sem marcá-lo como entregue", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "feito" }, "1");
  assert.equal((await h.orch.inbox({ consume: false })).length, 1);
  assert.equal((await h.orch.inbox({ consume: false })).length, 1, "continua visível na leitura");
  assert.equal((await h.orch.inbox()).length, 1, "consumo padrão entrega uma vez");
  assert.equal((await h.orch.inbox()).length, 0);
});

test("tailLog: texto curto passa inteiro; longo mantém a cauda e marca truncado", () => {
  assert.deepEqual(tailLog("abc", 10), { text: "abc", truncated: false });
  const out = tailLog("a".repeat(50) + "FIM", 20);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith("FIM"));
  assert.ok(out.text.length <= 20);
});
