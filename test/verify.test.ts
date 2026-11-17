import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeDone, type VerifyEnv } from "../src/verify.ts";

const PR = "https://github.com/o/r/pull/7";
const ok = { prCheck: async () => ({ ok: true, line: "Verificação da PR #7: VERIFICADA." }) };
const bad = { prCheck: async () => ({ ok: false, line: "Verificação da PR #7: NÃO VERIFICADA. checks falhando." }) };
function env(over: Partial<VerifyEnv> = {}): VerifyEnv {
  return {
    prCheck: ok.prCheck,
    commitExists: () => true,
    pathExists: () => true,
    ...over,
  };
}

test("status diferente de done não é conferido", async () => {
  const v = await judgeDone("direct-pr", "failed", [], env());
  assert.equal(v.verdict, "not_applicable");
});

test("direct-pr done sem URL de PR é reprovado", async () => {
  const v = await judgeDone("direct-pr", "done", [], env());
  assert.equal(v.verdict, "rejected");
  assert.match(v.reason, /sem PR/);
});

test("direct-pr com PR verificada é aprovado; com PR não verificada é reprovado", async () => {
  assert.equal((await judgeDone("direct-pr", "done", [PR], env(ok))).verdict, "approved");
  const v = await judgeDone("direct-pr", "done", [PR], env(bad));
  assert.equal(v.verdict, "rejected");
  assert.match(v.reason, /NÃO VERIFICADA/);
});

test("falha ao consultar a PR vira não verificada, nunca aprovada", async () => {
  const v = await judgeDone("direct-pr", "done", [PR], env({ prCheck: async () => { throw new Error("gh fora"); } }));
  assert.equal(v.verdict, "unverified");
  assert.notEqual(v.verdict, "approved");
});

test("local-only sem commit informado é reprovado; com SHA que existe é aprovado; SHA inexistente é reprovado", async () => {
  assert.equal((await judgeDone("local-only", "done", [], env())).verdict, "rejected");
  assert.equal((await judgeDone("local-only", "done", ["commit 3b4ac36 na branch fm/x"], env())).verdict, "approved");
  assert.equal((await judgeDone("local-only", "done", ["3b4ac36"], env({ commitExists: () => false }))).verdict, "rejected");
});

test("local-only: falha ao ler o repositório vira não verificada", async () => {
  const v = await judgeDone("local-only", "done", ["3b4ac36"], env({ commitExists: () => { throw new Error("git fora"); } }));
  assert.equal(v.verdict, "unverified");
});

test("report: artefato de caminho que não existe reprova; sem artefato não se aplica", async () => {
  assert.equal((await judgeDone("report", "done", ["/tmp/nao-existe.md"], env({ pathExists: () => false }))).verdict, "rejected");
  assert.equal((await judgeDone("report", "done", ["/tmp/ok.md"], env())).verdict, "approved");
  assert.equal((await judgeDone("report", "done", [], env())).verdict, "not_applicable");
});

test("design não tem verificação determinística", async () => {
  assert.equal((await judgeDone("design", "done", [], env())).verdict, "not_applicable");
});

test("local-only: palavra hexadecimal na prosa não reprova se um commit real está citado", async () => {
  const exists = (s: string) => s === "3b4ac36";
  const v = await judgeDone("local-only", "done", ["Ajustado em 3b4ac36; cache deadbeef na nota"], env({ commitExists: exists }));
  assert.equal(v.verdict, "approved");
});

test("local-only: nenhum SHA existe é reprovado mesmo com várias palavras hexadecimais", async () => {
  const v = await judgeDone("local-only", "done", ["deadbeef cafebabe"], env({ commitExists: () => false }));
  assert.equal(v.verdict, "rejected");
});
