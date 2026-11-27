import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { READ_ONLY_TOOLS } from "../shared/review.ts";

// keep: agente somente leitura do próprio repo (.pi/agents/oracle-ro.md); o gate lê esse arquivo antes de cada consulta.
export const ORACLE_AGENT = "oracle-ro";
const MARKER_RE = /Marcador de consulta: ([0-9a-f]{16})/;

// keep: captura da saída real do subagent é a prova de origem do parecer; o texto que o orquestrador repassa não basta.
export interface OracleCapture {
  token: string;
  agent: string;
  model: string | null;
  toolCallId: string;
  output: string;
}

// keep: marcador determinístico por tarefa e pergunta; liga a consulta lançada ao parecer que a pergunta aceita.
export function consultToken(taskId: string, askId: string): string {
  return createHash("sha256").update(`${taskId}|${askId}`).digest("hex").slice(0, 16);
}

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
  const file = join(input.cwd, ".pi", "agents", `${ORACLE_AGENT}.md`);
  if (!existsSync(file)) return `agente ${ORACLE_AGENT} não definido em .pi/agents deste projeto; consulta recusada`;
  return oracleToolGate(parseAgentTools(readFileSync(file, "utf8")));
}

interface Launch {
  token: string;
  agent: string;
  model: string | null;
}

// keep: captura em memória do processo do orquestrador; reinício entre consulta e parecer recusa o parecer (fail-closed).
export class OracleCaptures {
  private readonly launches = new Map<string, Launch>();
  private readonly byToken = new Map<string, OracleCapture>();

  noteCall(toolCallId: string, input: { agent?: unknown; task?: unknown; model?: unknown }): void {
    if (input.agent !== ORACLE_AGENT) return;
    const m = typeof input.task === "string" ? MARKER_RE.exec(input.task) : null;
    if (!m) return;
    const model = typeof input.model === "string" ? input.model : null;
    this.launches.set(toolCallId, { token: m[1], agent: ORACLE_AGENT, model });
  }

  noteResult(toolCallId: string, output: string, isError: boolean): void {
    const launch = this.launches.get(toolCallId);
    if (!launch) return;
    this.launches.delete(toolCallId);
    if (isError) return;
    this.byToken.set(launch.token, { ...launch, toolCallId, output });
  }

  get(token: string): OracleCapture | undefined {
    return this.byToken.get(token);
  }
}
