import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { READ_ONLY_TOOLS } from "../shared/review.ts";

// keep: agente somente leitura do próprio repo (.pi/agents/oracle-ro.md); o gate lê esse arquivo antes de cada consulta.
export const ORACLE_AGENT = "oracle-ro";
const PACKAGED_AGENT_DIR = fileURLToPath(new URL("../../.pi/agents/", import.meta.url));

// keep: somente leitura é o conjunto de review, sem bash; sem lista declarada não há prova de leitura.
export function oracleToolGate(tools: readonly string[] | undefined): string | null {
  if (tools === undefined || tools.length === 0)
    return `subagent oracle precisa declarar ferramentas somente leitura: ${READ_ONLY_TOOLS.join(", ")}`;
  const extra = tools.filter((t) => !(READ_ONLY_TOOLS as readonly string[]).includes(t));
  return extra.length === 0 ? null : `subagent oracle é somente leitura; recusado: ${extra.join(", ")}`;
}

// keep: o campo tools do frontmatter é a allowlist que o subagent recebe; sem ele, o agente herda todas as ferramentas.
export function parseAgentTools(markdown: string): string[] | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!frontmatter) return undefined;
  const line = /^tools:[ \t]*(.*)$/m.exec(frontmatter[1]);
  if (!line) return undefined;
  return line[1]
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

// keep: decisão do hook tool_call: consulta ao Oracle só roda se o agente do projeto for somente leitura.
export function oracleCallGate(input: { agent: unknown; cwd: string }): string | null {
  if (input.agent !== ORACLE_AGENT) return null;
  const userAgentDir = join(homedir(), ".pi", "agent", "agents");
  const extraAgentDirs = (process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS ?? "").split(delimiter).filter(Boolean);
  const agentDirs = [join(input.cwd, ".pi", "agents"), userAgentDir, ...extraAgentDirs, PACKAGED_AGENT_DIR].filter(
    (dir, index, dirs) => dirs.indexOf(dir) === index,
  );
  const file = agentDirs.map((dir) => join(dir, `${ORACLE_AGENT}.md`)).find(existsSync);
  if (!file) return `agente ${ORACLE_AGENT} não encontrado; consulta recusada`;
  return oracleToolGate(parseAgentTools(readFileSync(file, "utf8")));
}
