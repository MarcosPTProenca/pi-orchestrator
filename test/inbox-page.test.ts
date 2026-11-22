import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";

test("inboxPage: limite de itens, decisões primeiro, consumo só do que foi exibido", async () => {
  const h = makeHarness();
  for (let i = 0; i < 44; i++) {
    const t = await h.orch.delegate({
      project_path: h.project,
      role: "a",
      request: `x${i}`,
      objective: "y",
      mode: "report",
    });
    writeReport(t.task_dir, t.task_id, { status: "done", result: `feito ${i}` }, String(i));
    await h.orch.refreshAll();
  }
  const d = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "decisão",
    objective: "y",
    mode: "report",
  });
  writeReport(d.task_dir, d.task_id, { status: "blocked", question: "seguir com A ou B?" }, "decisao");
  await h.orch.refreshAll();

  const first = await h.orch.inboxPage({ consume: true, limit: 40 });
  assert.equal(first.items.length, 40);
  assert.equal(first.omitted, 5);
  assert.equal(first.items[0].status, "blocked", "decisão aparece antes dos avisos terminais");

  const second = await h.orch.inboxPage({ consume: true, limit: 40 });
  assert.equal(second.items.length, 6, "5 omitidos seguem pendentes, e a decisão continua aberta");
  assert.equal(second.omitted, 0);
  assert.equal(second.items.filter((i) => i.status === "blocked").length, 1);
});
