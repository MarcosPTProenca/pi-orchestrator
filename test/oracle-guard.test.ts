import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { READ_ONLY_TOOLS } from "../src/shared/review.ts";
import { ORACLE_AGENT, oracleCallGate, oracleToolGate, parseAgentTools } from "../src/orchestrator/oracle-guard.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// keep: projeto temporário com (ou sem) o agente oracle-ro, para testar o gate no mesmo caminho que o hook usa.
function projectWithAgent(tools: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "oracle-proj-"));
  if (tools === null) return root;
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", `${ORACLE_AGENT}.md`),
    `---\nname: ${ORACLE_AGENT}\ntools: ${tools}\n---\n\ncorpo\n`,
  );
  return root;
}

test("oracleToolGate recusa qualquer ferramenta que escreve ou executa", () => {
  for (const bad of ["bash", "edit", "write"]) {
    const reason = oracleToolGate([...READ_ONLY_TOOLS, bad]);
    assert.ok(reason, `a ferramenta ${bad} precisa ser recusada`);
    assert.ok(reason.includes(bad));
  }
  assert.ok(oracleToolGate(undefined), "sem lista declarada não há prova de somente leitura");
  assert.ok(oracleToolGate([]), "lista vazia não passa");
});

test("oracleToolGate aceita somente ferramentas de leitura, inclusive subconjunto", () => {
  assert.equal(oracleToolGate([...READ_ONLY_TOOLS]), null);
  assert.equal(oracleToolGate(["read", "grep"]), null);
});

test("parseAgentTools lê o campo tools do frontmatter e devolve undefined sem ele", () => {
  assert.deepEqual(parseAgentTools("---\nname: x\ntools: read, grep, find, ls\n---\ncorpo"), [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  assert.equal(parseAgentTools("---\nname: x\n---\ntools: bash no corpo, não no frontmatter"), undefined);
  assert.equal(parseAgentTools("sem frontmatter\ntools: read"), undefined);
});

test("oracleCallGate recusa bash e escrita no agente do Oracle", () => {
  for (const tools of ["read, grep, find, ls, bash", "read, grep, find, ls, edit", "read, write"]) {
    const reason = oracleCallGate({ agent: ORACLE_AGENT, cwd: projectWithAgent(tools) });
    assert.ok(reason, `tools: ${tools} precisa ser recusado`);
  }
  assert.match(
    oracleCallGate({ agent: ORACLE_AGENT, cwd: projectWithAgent("read, bash") }) ?? "",
    /bash/,
    "o motivo cita a ferramenta recusada",
  );
});

test("oracleCallGate recusa consulta quando o agente não está definido no projeto", () => {
  const reason = oracleCallGate({ agent: ORACLE_AGENT, cwd: projectWithAgent(null) });
  assert.match(reason ?? "", /não definido/);
});

test("oracleCallGate deixa passar agentes que não são do Oracle", () => {
  assert.equal(oracleCallGate({ agent: "researcher", cwd: projectWithAgent("read, bash") }), null);
});

test("oracleCallGate aceita o agente somente leitura versionado no repo", () => {
  assert.equal(oracleCallGate({ agent: ORACLE_AGENT, cwd: REPO_ROOT }), null);
  const text = readFileSync(join(REPO_ROOT, ".pi", "agents", `${ORACLE_AGENT}.md`), "utf8");
  assert.deepEqual(
    parseAgentTools(text),
    [...READ_ONLY_TOOLS],
    "o agente do repo tem exatamente as ferramentas de leitura",
  );
  assert.ok(existsSync(join(REPO_ROOT, ".pi", "agents", `${ORACLE_AGENT}.md`)));
});
