import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkIssueDelegation,
  issueNumberOf,
  issueSendScope,
  publicationConflict,
  repoFromRemote,
} from "../src/shared/delegation-gate.ts";
import type { DelegateInput } from "../src/shared/task.ts";

const REPO = "https://github.com/exemplo/herdr";

function implementation(overrides: Partial<DelegateInput> = {}): DelegateInput {
  return {
    project_path: "/tmp/proj",
    role: "impl-224",
    request: "Implemente a issue #224: painel de tarefas conforme o layout aprovado.",
    objective: "Critérios da issue #224 atendidos e PR aberto.",
    mode: "direct-pr",
    source: `${REPO}/issues/224`,
    acceptance: ["Painel exibe o status de cada tarefa", "npm test verde"],
    ...overrides,
  };
}

test("delegação de implementação válida passa o gate", () => {
  assert.equal(checkIssueDelegation(implementation(), "exemplo/herdr"), null);
});

test("delegação sem origin configurado não compara identidade do repositório", () => {
  assert.equal(checkIssueDelegation(implementation(), null), null);
});

test("pesquisa (report) com várias issues citadas continua legítima", () => {
  const research = implementation({
    mode: "report",
    request: "Investigar as issues #224, #225 e #226 e reportar dependências entre elas.",
    source: undefined,
    acceptance: undefined,
  });
  assert.equal(checkIssueDelegation(research, "exemplo/herdr"), null);
});

test("design continua fora do gate de implementação", () => {
  const design = implementation({ mode: "design", request: "Planejar as issues visuais.", acceptance: undefined });
  assert.equal(checkIssueDelegation(design, "exemplo/herdr"), null);
});

test("pedido de seleção sem issue é recusado com o motivo de seleção não resolvida", () => {
  const vague = implementation({ request: "Resolva as issues visuais.", source: undefined });
  const msg = checkIssueDelegation(vague, "exemplo/herdr");
  assert.ok(msg, "deve recusar");
  assert.match(msg, /recusada antes do lançamento/);
  assert.match(msg, /source ausente/);
  assert.match(msg, /seleção não resolvido/);
});

test("pedido 'identifique quais issues' com fonte #224 é recusado como seleção", () => {
  const msg = checkIssueDelegation(
    implementation({ request: "Identifique quais issues visuais implementar." }),
    "exemplo/herdr",
  );
  assert.match(msg ?? "", /seleção não resolvido/);
});

test("pedido que cita outra issue além da fonte é recusado", () => {
  const msg = checkIssueDelegation(
    implementation({ request: "Implemente a #224 e também a issue #229." }),
    "exemplo/herdr",
  );
  assert.match(msg ?? "", /cita outra issue \(#229\)/);
});

test("critérios de aceite ausentes na implementação por issue são recusados", () => {
  const msg = checkIssueDelegation(implementation({ acceptance: [] }), "exemplo/herdr");
  assert.match(msg ?? "", /critérios de aceite ausentes/);
});

test("fonte que não é URL canônica de issue é recusada", () => {
  const msg = checkIssueDelegation(implementation({ source: `${REPO}/pull/224` }), "exemplo/herdr");
  assert.match(msg ?? "", /não é a URL canônica de uma issue/);
});

test("fonte de outro repositório diverge do origin do projeto", () => {
  const msg = checkIssueDelegation(
    implementation({ source: "https://github.com/outro/repo/issues/224" }),
    "exemplo/herdr",
  );
  assert.match(msg ?? "", /origin do projeto é exemplo\/herdr/);
});

test("fix de PR (fonte pull, pedido cita PR) não é tratado como issue", () => {
  const fixPr: DelegateInput = {
    project_path: "/tmp/proj",
    role: "fix-pr-46",
    request: "Corrigir os checks vermelhos da PR #46.\nFonte: https://github.com/exemplo/herdr/pull/46",
    objective: "Checks da PR #46 verdes.",
    mode: "direct-pr",
    source: `${REPO}/pull/46`,
  };
  assert.equal(checkIssueDelegation(fixPr, "exemplo/herdr"), null);
});

test("issueSendScope recusa orientação que cita outra issue numa tarefa de implementação", () => {
  const msg = issueSendScope({ source: `${REPO}/issues/224`, mode: "direct-pr" }, "Passe a trabalhar na #225 também.");
  assert.match(msg ?? "", /troca de escopo recusada/);
  assert.match(msg ?? "", /#225/);
});

test("issueSendScope aceita orientação sobre a própria issue", () => {
  const msg = issueSendScope(
    { source: `${REPO}/issues/224`, mode: "direct-pr" },
    "Ajuste o contraste do painel da #224.",
  );
  assert.equal(msg, null);
});

test("issueSendScope aceita mensagem sem referência de issue", () => {
  assert.equal(issueSendScope({ source: `${REPO}/issues/224`, mode: "direct-pr" }, "Rode npm test de novo."), null);
});

test("issueSendScope não confunde número de PR com issue", () => {
  assert.equal(
    issueSendScope({ source: `${REPO}/issues/224`, mode: "direct-pr" }, "Confira o check da PR #230."),
    null,
  );
});

test("pesquisa pode investigar outra issue por send", () => {
  const msg = issueSendScope(
    { source: `${REPO}/issues/224`, mode: "report" },
    "Compare com a #225 e reporte a diferença.",
  );
  assert.equal(msg, null);
});

test("pesquisa não pode ser redirecionada para implementar outra issue", () => {
  const msg = issueSendScope({ source: `${REPO}/issues/224`, mode: "report" }, "Implemente a #225 agora.");
  assert.match(msg ?? "", /troca de escopo recusada/);
});

test("tarefa sem fonte de issue não sofre o gate de envio", () => {
  assert.equal(issueSendScope({ source: null, mode: "direct-pr" }, "Implemente a issue #229."), null);
});

test("issueNumberOf só aceita URL canônica de issue do GitHub", () => {
  assert.equal(issueNumberOf(`${REPO}/issues/224`), 224);
  assert.equal(issueNumberOf(`${REPO}/pull/224`), null);
  assert.equal(issueNumberOf(`${REPO}/issues/224/comments`), null);
  assert.equal(issueNumberOf(null), null);
});

test("repoFromRemote lê dono/repo de URL https e ssh", () => {
  assert.equal(repoFromRemote("https://github.com/Exemplo/Herdr.git"), "exemplo/herdr");
  assert.equal(repoFromRemote("git@github.com:exemplo/herdr.git"), "exemplo/herdr");
  assert.equal(repoFromRemote("/caminho/local"), null);
});

const PROIBE_PUBLICAR = "Não faça commit, push ou abra PR sem pedido explícito.";

test("direct-pr com restrição que proíbe commit/push/PR é recusado antes do lançamento (t-33ccf6d1)", () => {
  const msg = publicationConflict(implementation({ constraints: [PROIBE_PUBLICAR] }));
  assert.ok(msg, "deve recusar");
  assert.match(msg, /recusada antes do lançamento/);
  assert.match(msg, /direct-pr/);
  assert.match(msg, /restrição/);
  assert.match(msg, /modo report/);
  assert.ok(msg.includes(PROIBE_PUBLICAR), "a restrição do usuário aparece no erro, sem ser removida");
});

test("direct-pr sem restrição de publicação passa o gate de publicação", () => {
  assert.equal(publicationConflict(implementation({ constraints: ["Não tocar em outros arquivos."] })), null);
  assert.equal(publicationConflict(implementation({ constraints: undefined })), null);
});

test("pesquisa (report) com proibição de publicação é coerente e passa", () => {
  const research = implementation({ mode: "report", constraints: [PROIBE_PUBLICAR], acceptance: undefined });
  assert.equal(publicationConflict(research), null);
});

test("design com proibição de publicação continua fora do gate de publicação", () => {
  const design = implementation({ mode: "design", constraints: [PROIBE_PUBLICAR], acceptance: undefined });
  assert.equal(publicationConflict(design), null);
});
