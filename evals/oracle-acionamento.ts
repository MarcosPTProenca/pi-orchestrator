import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStream } from "./run.ts";
import type { Run } from "./scenarios.ts";

// keep: eval de regressão do issue #243: pedido operacional de issues já definidas não aciona o Oracle; pedido de spec/tickets aciona a revisão prevista. A escolha do LLM é o que se mede, não o conteúdo do plano.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const model = flag("--model") ?? "openai-codex/gpt-6.1-sol";

// keep: gh falso com as issues #239-#241 do caso real; não publica nada, e o runner grava em disco para o wrapper gh.
const GH_FAKE_SOURCE = `const repo = "https://github.com/exemplo/herdr";
const issues = {
  239: { number: 239, title: "Confirmação humana da triagem", state: "OPEN",
    body: "Bloqueada por: nenhuma.\\nExigir confirmação do usuário antes de aprovar o plano." },
  240: { number: 240, title: "Gate de contrato de issue", state: "OPEN",
    body: "Bloqueada por: #239.\\nValidar o contrato da issue antes do lançamento." },
  241: { number: 241, title: "Relatório de triagem", state: "OPEN",
    body: "Bloqueada por: #240.\\nMostrar o relatório de triagem ao usuário." },
};
const withUrl = (i) => ({ ...i, url: repo + "/issues/" + i.number });
const [a, b, c] = process.argv.slice(2);
if (a === "issue" && b === "list") console.log(JSON.stringify(Object.values(issues).map(withUrl)));
else if (a === "issue" && b === "view") {
  const i = issues[c];
  if (!i) { console.error("Could not resolve to an issue"); process.exit(1); }
  console.log(JSON.stringify(withUrl(i)));
} else { console.error("comando não simulado: gh " + process.argv.slice(2).join(" ")); process.exit(1); }
`;

const OPERATIONAL_TURNS = [
  "Execute as issues #239, #240 e #241 do repositório exemplo/herdr, a partir do projeto __ALPHA__. " +
    "Modelo claude-bridge/claude-haiku-5-5, modo direct-pr. #239 vai primeiro e #240 e #241 dependem dela. " +
    "Monte o plano, mostre a lista selecionada e espere minha confirmação antes de aprovar.",
  "Confirmo a lista como você mostrou. Pode aprovar o plano e lançar o que as dependências liberarem.",
];
const SPEC_TURNS = [
  "Quero especificar uma ideia para o projeto __ALPHA__: um comando que resume os erros recentes. " +
    "Faça grill-with-docs, to-spec e to-tickets com você mesmo e mostre a spec e os tickets. Não crie nada no GitHub ainda.",
  "Respostas da entrevista: quem usa é o dev que abre o terminal; o problema é que leio muitos logs e perco tempo; " +
    "o resultado é um resumo curto dos erros da última hora. Pode seguir com a especificação e mostrar spec e tickets. Não crie nada no GitHub.",
];

const isOracle = (name: string, agent: unknown) => name === "subagent" && (agent === "oracle-ro" || agent === "oracle");

function runTurn(prompt: string, session: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["--mode", "json", "--model", model, "-e", join(ROOT, "src", "index.ts"), "--session", session, "-p", prompt],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGTERM"), 900_000);
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseStream(out));
    });
  });
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "oracle-acion-"));
  const alpha = join(base, "alpha");
  mkdirSync(alpha, { recursive: true });
  execFileSync("git", ["init", "-q", alpha]);
  writeFileSync(join(alpha, "README.md"), "# alpha\n\nProjeto de teste do acionamento do Oracle.\n");
  const ghBin = join(base, "gh-bin");
  mkdirSync(ghBin);
  writeFileSync(join(ghBin, "gh.mjs"), GH_FAKE_SOURCE);
  writeFileSync(
    join(ghBin, "gh"),
    `#!/bin/sh\necho "gh $*" >> "${join(base, "gh.log")}"\nexec "${process.execPath}" "${join(ghBin, "gh.mjs")}" "$@"\n`,
  );
  chmodSync(join(ghBin, "gh"), 0o755);
  const env = {
    ...process.env,
    PATH: `${ghBin}:${process.env.PATH ?? ""}`,
    PI_ORCH_DRY_RUN: "1",
    PI_ORCH_STATE_DIR: join(base, "state"),
    PWD: alpha,
  };

  // keep: cenário A é o pedido operacional de issues já definidas; nenhum Oracle pode ser chamado.
  const opSession = join(base, "operacional.jsonl");
  const opRuns: Run[] = [];
  for (const prompt of OPERATIONAL_TURNS)
    opRuns.push(await runTurn(prompt.replace("__ALPHA__", alpha), opSession, env));
  const [op1, op2] = opRuns;
  const opOracle = opRuns.flatMap((r) => r.calls).filter((c) => isOracle(c.name, c.args.agent));
  const opChecks = [
    {
      name: "operacional: nenhuma chamada ao subagent oracle",
      ok: opOracle.length === 0,
      detail: `chamadas=${opOracle.length}`,
    },
    {
      name: "operacional: aprova só depois da confirmação do usuário",
      ok:
        !op1.calls.some((c) => c.name === "orch_plan_approve") && op2.calls.some((c) => c.name === "orch_plan_approve"),
      detail: `t1=${op1.calls.filter((c) => c.name === "orch_plan_approve").length} t2=${op2.calls.filter((c) => c.name === "orch_plan_approve").length}`,
    },
  ];

  // keep: cenário B é spec e tickets; a revisão do Oracle continua prevista.
  const specSession = join(base, "spec.jsonl");
  const specRuns: Run[] = [];
  for (const prompt of SPEC_TURNS) specRuns.push(await runTurn(prompt.replace("__ALPHA__", alpha), specSession, env));
  const specCalls = specRuns.flatMap((r) => r.calls);
  const specChecks = [
    {
      name: "spec/tickets: subagent oracle-ro chamado antes de apresentar",
      ok: specCalls.some((c) => isOracle(c.name, c.args.agent)),
      detail: specRuns.map((r) => r.calls.map((c) => c.name).join(" > ")).join(" || "),
    },
    {
      name: "spec/tickets: nenhum worker lançado para conduzir as etapas",
      ok: !specCalls.some((c) => c.name === "orch_delegate"),
      detail: specRuns.map((r) => r.calls.map((c) => c.name).join(" > ")).join(" || "),
    },
  ];

  // keep: ordem da triagem (rascunho antes da confirmação) é comportamento do modelo, fora do alvo do #243: só informa.
  console.log(
    `info operacional: rascunho criado no turno 1? ${op1.calls.some((c) => c.name === "orch_plan_create") ? "sim" : "não"}`,
  );
  const checks = [...opChecks, ...specChecks];
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` :: ${c.detail}`}`);
  }
  console.log(`operacional tools t1: ${op1.calls.map((c) => c.name).join(" > ")}`);
  console.log(`operacional tools t2: ${op2.calls.map((c) => c.name).join(" > ")}`);
  console.log(`spec tools t1: ${specRuns[0].calls.map((c) => c.name).join(" > ")}`);
  console.log(`spec tools t2: ${specRuns[1].calls.map((c) => c.name).join(" > ")}`);
  console.log(`modelo: ${model} | sessões: ${opSession}, ${specSession}`);
  console.log(`Resumo: ${checks.length - failed}/${checks.length} checagens passaram.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
