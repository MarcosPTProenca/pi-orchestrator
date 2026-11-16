import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateProject, queryTerms } from "../src/locate.ts";

function repo(root: string, name: string, readme: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (readme) writeFileSync(join(dir, "README.md"), readme);
}

test("queryTerms: palavras com 3+ letras, sem acento, minúsculas", () => {
  assert.deepEqual(queryTerms("Ensalamento do JOB, já"), ["ensalamento", "job"]);
});

test("locateProject acha pelo nome e pelo conteúdo do README, com o termo que casou", () => {
  const root = mkdtempSync(join(tmpdir(), "loc-"));
  repo(root, "job-planejamento-oferta", "# Job de planejamento\nmódulo de ensalamento de turmas.");
  repo(root, "otmizacao-oferta", "solver de ensalamento e heurística");
  repo(root, "outro-projeto", "nada a ver");
  mkdirSync(join(root, "pasta-sem-git"));
  const found = locateProject("ensalamento", root);
  assert.deepEqual(found.map((f) => f.name).sort(), ["job-planejamento-oferta", "otmizacao-oferta"]);
  assert.ok(found.every((f) => f.matched.some((m) => m.includes("ensalamento"))));
});

test("locateProject ignora diretórios sem .git e consulta sem termos úteis é erro", () => {
  const root = mkdtempSync(join(tmpdir(), "loc2-"));
  mkdirSync(join(root, "ensalamento-sem-git"));
  assert.deepEqual(locateProject("ensalamento", root), []);
  assert.throws(() => locateProject("de a", root), /sem termos úteis/);
});
