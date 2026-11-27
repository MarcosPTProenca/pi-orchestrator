import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskRecord } from "../src/shared/contract.ts";
import { diagnoseLostTask, lostSummary, type DiagnosisFacts } from "../src/orchestrator/lost-diagnosis.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function facts(over: Partial<DiagnosisFacts> = {}): DiagnosisFacts {
  const task = {
    task_id: "t-1",
    status: "running",
    updated_at: "2026-11-16T12:00:00.000Z",
    result: null,
    error: null,
    artifacts: [],
    source: null,
    branch: null,
  } as unknown as TaskRecord;
  return {
    now: "2026-11-16T12:05:00.000Z",
    task,
    report: { state: "ausente" },
    publish: null,
    publishError: null,
    worktree: { state: "ausente" },
    session: null,
    pane: "ausente",
    prUrl: null,
    ...over,
  };
}

test("sem nenhuma fonte com evidência: nível none, sem afirmar que nada foi feito", () => {
  const d = diagnoseLostTask(facts());
  assert.equal(d.level, "none");
  assert.deepEqual(d.evidence, []);
  assert.ok(d.pending.some((p) => p.includes("não prova que a tarefa não avançou")));
  assert.equal(d.sources.find((s) => s.source === "relatorio")?.state, "ausente");
  assert.equal(d.sources.find((s) => s.source === "pr")?.state, "ausente");
});

test("commit local sem push na worktree: nível partial, cita o commit e a worktree", () => {
  const d = diagnoseLostTask(
    facts({
      publish: {
        task_id: "t-1",
        attempt_id: "x",
        branch: "feat/a",
        base_sha: BASE,
        head_sha: HEAD,
        pushed_sha: null,
        pr_url: null,
      },
      worktree: { state: "encontrada", path: "/wt/a", head: HEAD, dirty: false, pushed: false },
    }),
  );
  assert.equal(d.level, "partial");
  assert.ok(d.evidence.includes(`commit ${HEAD.slice(0, 12)} criado na worktree, não publicado`));
  assert.match(d.recovery, /inspecione a worktree \/wt\/a/);
  assert.match(d.recovery, /Nada foi relançado/);
});

test("worktree com alterações não commitadas conta como evidência parcial", () => {
  const d = diagnoseLostTask(
    facts({ worktree: { state: "encontrada", path: "/wt/a", head: BASE, dirty: true, pushed: true } }),
  );
  assert.equal(d.level, "partial");
  assert.ok(d.evidence.includes("alterações não commitadas em /wt/a"));
});

test("PR registrada é evidência parcial e deixa os checks como pendência", () => {
  const url = "https://github.com/o/r/pull/12";
  const d = diagnoseLostTask(facts({ prUrl: url }));
  assert.equal(d.level, "partial");
  assert.ok(d.evidence.includes(`PR ${url}`));
  assert.ok(d.pending.includes("checks da PR não consultados neste diagnóstico"));
});

test("relatório done gravado: nível verified, mas o diagnóstico não conclui a tarefa", () => {
  const d = diagnoseLostTask(facts({ report: { state: "valido", status: "done", result: "feito" } }));
  assert.equal(d.level, "verified");
  assert.match(d.recovery, /não foi marcada como concluída/);
  assert.equal("status" in d, false);
});

test("relatório ilegível vira fonte indisponível, não ausência", () => {
  const d = diagnoseLostTask(facts({ report: { state: "invalido", detail: "JSON inválido" } }));
  const rel = d.sources.find((s) => s.source === "relatorio");
  assert.equal(rel?.state, "indisponivel");
  assert.ok(d.pending.includes("relatório ilegível: o resultado não pode ser confirmado"));
});

test("worktree indisponível fica registrada com o motivo", () => {
  const d = diagnoseLostTask(facts({ worktree: { state: "indisponivel", detail: "git falhou" } }));
  assert.equal(d.sources.find((s) => s.source === "worktree")?.state, "indisponivel");
  assert.ok(d.pending.includes("worktree não verificada: git falhou"));
});

test("publish-state ilegível vira fonte indisponível e pendência, nunca 'sem commit'", () => {
  const d = diagnoseLostTask(facts({ publishError: "JSON inválido" }));
  assert.equal(d.sources.find((x) => x.source === "estado")?.state, "indisponivel");
  assert.ok(d.pending.some((p) => p.includes("estado de publicação ilegível")));
  assert.notEqual(d.level, "verified");
});

test("resumo traz nível, evidências, pendências e ação segura", () => {
  const d = diagnoseLostTask(facts({ prUrl: "https://github.com/o/r/pull/3" }));
  const s = lostSummary(d);
  assert.match(s, /^Diagnóstico \(partial\)/);
  assert.match(s, /PR https:\/\/github\.com\/o\/r\/pull\/3/);
  assert.match(s, /Pendências:/);
  assert.match(s, /Ação segura:/);
});
