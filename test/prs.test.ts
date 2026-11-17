import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRedPrs, parseGraphqlRedPrs, repoFromRemote, fixInputFor, ghEnvFor, conflictNote, prFromUrl, prStateLine, verifyPr, verificationLine } from "../src/prs.ts";
import { FixQueue } from "../src/queue.ts";

const sample = [
  { number: 137, title: "feat: rota", headRefName: "fm/al-issue-63-q1", url: "https://github.com/MarcosPTProenca/adaptative-learning/pull/137",
    statusCheckRollup: [{ name: "check", conclusion: "SUCCESS" }, { name: "quality", conclusion: "FAILURE" }] },
  { number: 138, title: "verde", headRefName: "x", url: "u", statusCheckRollup: [{ name: "check", conclusion: "SUCCESS" }] },
  { number: 139, title: "status antigo", headRefName: "y", url: "u", statusCheckRollup: [{ context: "ci", state: "ERROR" }, { name: "pending", conclusion: null }] },
];

test("parseRedPrs mantém só PRs com check falhando e lista os nomes", () => {
  const red = parseRedPrs(sample);
  assert.deepEqual(red.map((p) => p.number), [137, 139]);
  assert.deepEqual(red[0].failing, ["quality"]);
  assert.deepEqual(red[1].failing, ["ci"]);
});

test("fixInputFor monta pedido, objetivo, restrições e modo direct-pr na branch da PR", () => {
  const [pr] = parseRedPrs(sample);
  const input = fixInputFor(pr, "/repo", "claude-bridge/claude-haiku-5-5");
  assert.equal(input.mode, "direct-pr");
  assert.equal(input.branch, "fm/al-issue-63-q1");
  assert.equal(input.model, "claude-bridge/claude-haiku-5-5");
  assert.equal(input.source, pr.url);
  assert.match(input.request, /PR #137/);
  assert.match(input.request, /quality/);
  assert.ok(input.constraints?.some((c) => /baselines/.test(c)));
});

test("ghEnvFor não usa a credencial pessoal em repositório de outro dono", () => {
  const base = { PATH: "/x" } as NodeJS.ProcessEnv;
  assert.equal(ghEnvFor("git@github.com:outra-org/repo.git", base).GH_TOKEN, undefined);
});

test("FixQueue mantém no máximo N em execução e avança quando um termina", async () => {
  const started: string[] = [];
  const q = new FixQueue<string>(2, async (item) => {
    started.push(item);
    return `t-${item}`;
  });
  await q.enqueue(["a", "b", "c", "d", "e"]);
  assert.deepEqual(started, ["a", "b"], "só dois em paralelo");
  assert.equal(q.pendingCount, 3);
  await q.settle("t-a");
  assert.deepEqual(started, ["a", "b", "c"]);
  await q.settle("t-x-fora-da-fila");
  assert.equal(q.pendingCount, 2, "tarefa fora da fila não libera slot");
  await q.settle("t-b");
  await q.settle("t-c");
  await q.settle("t-d");
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
});

test("FixQueue: falha ao iniciar um item não trava a fila", async () => {
  const q = new FixQueue<string>(2, async (item) => {
    if (item === "bad") throw new Error("delegação recusada");
    return `t-${item}`;
  }, { maxAttempts: 1 });
  await q.enqueue(["bad", "a", "b"]);
  assert.equal(q.failed.length, 1);
  assert.deepEqual(q.runningIds.sort(), ["t-a", "t-b"]);
});

test("repoFromRemote reconhece https, ssh e alias de host", () => {
  assert.deepEqual(repoFromRemote("git@github-pers:MarcosPTProenca/adaptative-learning.git"), { owner: "MarcosPTProenca", name: "adaptative-learning" });
  assert.deepEqual(repoFromRemote("https://github.com/owner/repo"), { owner: "owner", name: "repo" });
  assert.throws(() => repoFromRemote("nada-aqui"), /remote não reconhecido/);
});

test("parseGraphqlRedPrs traduz a resposta do GraphQL para PRs vermelhas", () => {
  const gql = { data: { repository: { pullRequests: { nodes: [
    { number: 129, title: "t", url: "https://github.com/o/r/pull/129", headRefName: "fm/x",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "quality", conclusion: "FAILURE" }] } } } }] } },
    { number: 93, title: "ok", url: "u", headRefName: "y",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "check", conclusion: "SUCCESS" }] } } } }] } },
  ] } } } };
  const red = parseGraphqlRedPrs(gql);
  assert.deepEqual(red.map((p) => [p.number, p.failing]), [[129, ["quality"]]]);
});

test("conflictNote avisa o worker quando a PR tem conflito com a base", () => {
  const [pr] = parseGraphqlRedPrs({ data: { repository: { pullRequests: { nodes: [
    { number: 131, title: "t", url: "https://github.com/o/r/pull/131", headRefName: "fm/al-issue-52-q1", baseRefName: "fm/al-issue-51-q1",
      mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "quality", conclusion: "FAILURE" }] } } } }] } },
    ] } } } });
  assert.equal(pr.mergeStateStatus, "DIRTY");
  assert.match(conflictNote(pr), /conflito de merge contra a base fm\/al-issue-51-q1/);
  const input = fixInputFor(pr, "/repo");
  assert.ok(input.constraints?.some((c) => /conflito com a base fm\/al-issue-51-q1/.test(c)));
  assert.match(input.objective, /conflito/);
});

test("PR limpa não ganha aviso de conflito", () => {
  const [pr] = parseGraphqlRedPrs({ data: { repository: { pullRequests: { nodes: [
    { number: 9, title: "t", url: "u", headRefName: "x", baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "q", conclusion: "FAILURE" }] } } } }] } },
    ] } } } });
  assert.equal(conflictNote(pr), "");
});

test("prFromUrl e prStateLine", () => {
  assert.deepEqual(prFromUrl("https://github.com/MarcosPTProenca/adaptative-learning/pull/131"), { owner: "MarcosPTProenca", name: "adaptative-learning", number: 131 });
  assert.equal(prFromUrl("https://example.com/x"), null);
  assert.match(prStateLine({ number: 131, state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", headRefOid: "x", checks: [] }), /CONFLITO/);
});

const green = (name: string) => ({ name, conclusion: "SUCCESS", status: "COMPLETED" });
const base = { number: 7, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc" };

test("verificação: PR aberta, mergeável e com checks verdes é VERIFICADA", () => {
  const s = { ...base, checks: [green("quality"), green("check")] };
  assert.deepEqual(verifyPr(s), []);
  assert.match(verificationLine(s), /VERIFICADA \(2\/2 checks verdes/);
});

test("verificação: check vermelho, em andamento ou conflito impedem a verificação", () => {
  assert.deepEqual(verifyPr({ ...base, checks: [{ name: "quality", conclusion: "FAILURE", status: "COMPLETED" }] }), ['check "quality" FAILURE']);
  assert.deepEqual(verifyPr({ ...base, checks: [{ name: "quality", conclusion: null, status: "IN_PROGRESS" }] }), ['check "quality" ainda IN_PROGRESS']);
  const conflict = verifyPr({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", checks: [green("q")] });
  assert.deepEqual(conflict, ["conflito de merge com a base"]);
  assert.match(verificationLine({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", checks: [green("q")] }), /NÃO VERIFICADA/);
});

test("verificação: PR fechada ou sem checks não é verificada", () => {
  assert.ok(verifyPr({ ...base, state: "CLOSED", checks: [green("q")] }).some((p) => /CLOSED/.test(p)));
  assert.deepEqual(verifyPr({ ...base, checks: [] }), ["nenhum check reportado"]);
});

test("verificação: PR já mesclada conta como verificada", () => {
  assert.deepEqual(verifyPr({ ...base, state: "MERGED", mergeable: "UNKNOWN", checks: [] }), []);
  assert.match(verificationLine({ ...base, state: "MERGED", checks: [] }), /já mesclada/);
});

test("FixQueue tenta de novo um início que falhou e só desiste depois do limite", async () => {
  const calls: string[] = [];
  const q = new FixQueue<string>(2, async (item) => {
    calls.push(item);
    if (item === "flaky" && calls.filter((c) => c === "flaky").length === 1) throw new Error("timeout de inicialização");
    if (item === "dead") throw new Error("sempre falha");
    return `t-${item}`;
  }, { maxAttempts: 2 });
  await q.enqueue(["flaky", "dead", "a"]);
  assert.deepEqual(q.runningIds.sort(), ["t-a", "t-flaky"].sort(), "flaky entrou na segunda tentativa");
  await q.settle("t-a");
  assert.equal(q.failed.length, 1, "dead desistiu após o limite");
  assert.equal(q.failed[0].attempts, 2);
});
