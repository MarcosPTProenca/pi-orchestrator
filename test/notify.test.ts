import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationFor, notifyEnabled, notifyArgs } from "../src/notify.ts";

const base = { task_id: "t-1a2b3c", project_id: "alpha", result: null, question: null, artifacts: [], error: null };

test("bloqueio, conclusão e falha notificam; andamento e cancelamento não", () => {
  assert.equal(notificationFor({ ...base, status: "blocked", question: "A ou B?" } as never)?.sound, "request");
  assert.equal(notificationFor({ ...base, status: "done", result: "feito" } as never)?.sound, "done");
  assert.equal(notificationFor({ ...base, status: "failed", error: "cota" } as never)?.sound, "request");
  assert.equal(notificationFor({ ...base, status: "running" } as never), null);
  assert.equal(notificationFor({ ...base, status: "cancelled" } as never), null);
});

test("título diz o projeto e o corpo traz a pergunta, limitada a 160 caracteres", () => {
  const n = notificationFor({ ...base, status: "blocked", question: "x".repeat(300) } as never)!;
  assert.equal(n.title, "Decisão necessária: alpha");
  assert.ok(n.body.length <= 160);
});

test("PI_ORCH_NOTIFY=0 desliga; padrão liga", () => {
  assert.equal(notifyEnabled({}), true);
  assert.equal(notifyEnabled({ PI_ORCH_NOTIFY: "0" }), false);
  assert.equal(notifyEnabled({ PI_ORCH_NOTIFY: "1" }), true);
});

test("argumentos do herdr notification show, sem shell", () => {
  const n = notificationFor({ ...base, status: "done", result: "PR aberta" } as never)!;
  assert.deepEqual(notifyArgs(n).slice(0, 2), ["notification", "show"]);
  assert.ok(notifyArgs(n).includes("--sound"));
  assert.ok(notifyArgs(n).includes("done"));
});
