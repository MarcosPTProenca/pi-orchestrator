import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";
import { tailLog } from "../src/shared/logs.ts";

test("orch_inbox sem consumo: lê o aviso sem marcá-lo como entregue", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "feito" }, "1");
  const antes = JSON.stringify(h.orch.list());
  assert.equal((await h.orch.inbox({ consume: false })).length, 0, "leitura pura não coleta o relatório pronto");
  assert.equal(JSON.stringify(h.orch.list()), antes, "leitura pura não altera o estado");
  assert.equal((await h.orch.inbox()).length, 1, "consumo padrão coleta e entrega uma vez");
  assert.equal((await h.orch.inbox({ consume: false })).length, 0, "já entregue não reaparece na leitura");
  assert.equal((await h.orch.inbox()).length, 0);
});

test("tailLog: texto curto passa inteiro; longo mantém a cauda e marca truncado", () => {
  assert.deepEqual(tailLog("abc", 10), { text: "abc", truncated: false });
  const out = tailLog("a".repeat(50) + "FIM", 20);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith("FIM"));
  assert.ok(out.text.length <= 20);
});
