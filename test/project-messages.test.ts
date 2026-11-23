import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { idleNoticeFor, modelMessageFor, orphanReleaseNoticeFor, projectLabel } from "../src/index.ts";
import { makeHarness, writeReport } from "./fakes.ts";

test("projeto vazio vira 'projeto não identificado', sem nome inventado", () => {
  assert.equal(projectLabel(""), "projeto não identificado");
  assert.equal(projectLabel("  "), "projeto não identificado");
  assert.equal(projectLabel("alpha"), "alpha");
  const msg = modelMessageFor({
    task_id: "t-1",
    project_id: "",
    status: "done",
    result: "ok",
    artifacts: [],
    error: null,
    question: null,
  } as never);
  assert.match(msg, /tarefa t-1 \(projeto não identificado\): done/);
});

test("aviso de ociosas leva o projeto de cada tarefa, inclusive com o mesmo número de issue", () => {
  const msg = idleNoticeFor([
    { task_id: "t-a1", project_id: "adaptative-learning" },
    { task_id: "t-b2", project_id: "rko" },
  ]);
  assert.match(msg, /t-a1 \(adaptative-learning\), t-b2 \(rko\)/);
});

test("aviso de worktrees arrendadas separa por projeto", () => {
  const msg = orphanReleaseNoticeFor({
    released: [
      { path: "/wt/a/1", holder: "t-a1", project: "alpha" },
      { path: "/wt/b/1", holder: "t-b2", project: "beta" },
    ],
    kept: [],
  });
  assert.match(msg, /alpha: \/wt\/a\/1 \(t-a1\); beta: \/wt\/b\/1 \(t-b2\)/);
});

test("ponta a ponta: duas tarefas em dois projetos; cada aviso identifica o seu projeto", async () => {
  const h = makeHarness();
  const projB = mkdtempSync(join(tmpdir(), "orch-projB-"));
  mkdirSync(join(projB, ".git"));
  const a = await h.orch.delegate({
    project_path: h.project,
    role: "issue 76",
    request: "x",
    objective: "y",
    mode: "report",
  });
  const b = await h.orch.delegate({
    project_path: projB,
    role: "issue 76",
    request: "x",
    objective: "y",
    mode: "report",
  });
  writeReport(a.task_dir, a.task_id, { status: "done", result: "PROJETO-A pronto" }, "2");
  writeReport(b.task_dir, b.task_id, { status: "blocked", question: "PROJETO-B: opção 1 ou 2?" }, "2");
  const ea = await h.orch.refresh(a.task_id);
  const eb = await h.orch.refresh(b.task_id);
  assert.ok(ea && eb, "os dois eventos chegam");
  const batch = [modelMessageFor(ea), modelMessageFor(eb)].join("\n\n---\n\n");
  const [partA, partB] = batch.split("\n\n---\n\n");
  const nameA = basename(h.project);
  const nameB = basename(projB);
  assert.match(partA, new RegExp(`tarefa ${a.task_id} \\(${nameA}\\): done`));
  assert.match(partA, /PROJETO-A pronto/);
  assert.doesNotMatch(partA, new RegExp(b.task_id));
  assert.doesNotMatch(partA, /PROJETO-B/);
  assert.match(partB, new RegExp(`tarefa ${b.task_id} \\(${nameB}\\): blocked`));
  assert.match(partB, /PROJETO-B: opção 1 ou 2\?/);
  assert.doesNotMatch(partB, /PROJETO-A/);
});

test("dois repos com o mesmo nome de pasta ganham nomes distintos nas mensagens (#65)", async () => {
  const h = makeHarness();
  const base = mkdtempSync(join(tmpdir(), "orch-clash-"));
  const a = join(base, "casa-a", "app");
  const b = join(base, "casa-b", "app");
  for (const p of [a, b]) {
    mkdirSync(p, { recursive: true });
    mkdirSync(join(p, ".git"));
  }
  const t1 = await h.orch.delegate({ project_path: a, role: "a", request: "x", objective: "y", mode: "report" });
  const t2 = await h.orch.delegate({ project_path: b, role: "a", request: "x", objective: "y", mode: "report" });
  assert.notEqual(h.orch.get(t1.task_id).project_id, h.orch.get(t2.task_id).project_id);
  assert.equal(h.orch.get(t2.task_id).project_id, "casa-b/app");
});

test("mesma branch em repos diferentes com o mesmo nome de pasta não conflita (#65)", async () => {
  const h = makeHarness();
  const base = mkdtempSync(join(tmpdir(), "orch-clash-"));
  const a = join(base, "pai-x", "app");
  const b = join(base, "pai-y", "app");
  for (const p of [a, b]) {
    mkdirSync(p, { recursive: true });
    mkdirSync(join(p, ".git"));
  }
  await h.orch.delegate({
    project_path: a,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
    branch: "feat/x",
  } as never);
  assert.equal(
    h.orch.activeConflict({
      project_path: b,
      role: "a",
      request: "x",
      objective: "y",
      mode: "report",
      branch: "feat/x",
    } as never),
    null,
  );
});
