/**
 * Intake determinístico: valida a solicitação e reúne o contexto obrigatório do projeto.
 * Não chama LLM. O brief resultante preserva o pedido literal e as restrições.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const MODES = ["report", "direct-pr", "local-only"] as const;
export type Mode = (typeof MODES)[number];

export interface IntakeInput {
  project_path: string;
  role: string;
  /** Pedido do usuário, literal. */
  request: string;
  /** Objetivo verificável: o que significa ter terminado. */
  objective: string;
  mode: Mode;
  constraints?: string[];
  /** Fonte da tarefa: URL de PR ou issue, quando houver. */
  source?: string;
  /** Branch de trabalho (ex.: head da PR). Omitida: o worker a descobre. */
  branch?: string;
  /** Especificação de construção opcional, escrita pelo orquestrador quando há julgamento. */
  spec?: string;
  /** Modelo já validado (provider/id) ou undefined para o padrão. */
  model?: string;
}

export interface IntakePack {
  project_path: string;
  project_id: string;
  role: string;
  request: string;
  objective: string;
  mode: Mode;
  constraints: string[];
  source: string | null;
  branch: string | null;
  spec: string | null;
  model: string | null;
  project_instructions: { file: string; content: string }[];
  acceptance: string[];
}

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTION_CHARS = 6000;

/** Mesmo texto de placeholder que o FirstMate recusa. */
const PLACEHOLDER = /\{[A-Z][A-Z_]+\}/;

function nonEmpty(field: string, value: string | undefined): string {
  if (!value || value.trim() === "") throw new Error(`${field} vazio`);
  if (PLACEHOLDER.test(value)) throw new Error(`${field} ainda tem placeholder: ${value.match(PLACEHOLDER)?.[0]}`);
  return value.trim();
}

export function acceptanceFor(mode: Mode, branch: string | null): string[] {
  switch (mode) {
    case "report":
      return [
        "Relatório em `result`: o que foi feito, o que foi encontrado, evidências (comandos e saídas, arquivo:linha) e recomendação.",
        "Nenhum push e nenhum PR.",
      ];
    case "direct-pr":
      return [
        "Implementar o pedido seguindo a skill `implement`: entender, implementar, testar, revisar.",
        branch
          ? `Commit na branch \`${branch}\`, push e PR aberto ou atualizado com gh.`
          : "Commit na branch de trabalho, push e PR aberto ou atualizado com gh (descubra a branch da PR citada, se houver).",
        "Checks do PR verificados; falha do próprio código corrigida até ficarem verdes.",
        "URL completa do PR em `artifacts`.",
      ];
    case "local-only":
      return [
        "Implementar o pedido seguindo a skill `implement`, com testes.",
        "Commit local na branch de trabalho. Nenhum push e nenhum PR.",
      ];
  }
}

function readInstructions(projectPath: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const file of PROJECT_FILES) {
    const path = join(projectPath, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    out.push({ file, content: text.length > MAX_INSTRUCTION_CHARS ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[truncado]` : text });
  }
  return out;
}

/** Valida tudo antes de qualquer lançamento. Lança erro explícito; nunca corrige em silêncio. */
export function buildIntake(input: IntakeInput): IntakePack {
  if (!input.project_path.startsWith("/") || !existsSync(input.project_path) || !statSync(input.project_path).isDirectory()) {
    throw new Error(`project_path precisa ser um diretório absoluto existente: ${input.project_path}`);
  }
  if (!existsSync(join(input.project_path, ".git"))) {
    throw new Error(`project_path não é a raiz de um repositório git: ${input.project_path}`);
  }
  if (!(MODES as readonly string[]).includes(input.mode)) {
    throw new Error(`mode inválido: ${String(input.mode)} (use ${MODES.join(", ")})`);
  }
  const branch = input.branch?.trim() || null;
  return {
    project_path: input.project_path,
    project_id: basename(input.project_path),
    role: nonEmpty("role", input.role),
    request: nonEmpty("request", input.request),
    objective: nonEmpty("objective", input.objective),
    mode: input.mode,
    constraints: (input.constraints ?? []).map((c) => nonEmpty("constraint", c)),
    source: input.source?.trim() || null,
    branch,
    spec: input.spec?.trim() ? nonEmpty("spec", input.spec) : null,
    model: input.model ?? null,
    project_instructions: readInstructions(input.project_path),
    acceptance: acceptanceFor(input.mode, branch),
  };
}

/** Brief completo, com contrato fixo. Todas as seções obrigatórias existem sempre. */
export function renderBrief(taskId: string, pack: IntakePack, reportPath: string): string {
  const lines: string[] = [
    `# Tarefa ${taskId} (papel: ${pack.role}, modo: ${pack.mode})`,
    "",
    "Você é um worker: uma sessão autônoma gerenciada pelo orquestrador. Trabalhe sem esperar um humano.",
    "",
    "## Pedido do usuário (literal)",
    pack.request,
    "",
    "## Objetivo",
    pack.objective,
    "",
    "## Fonte",
    pack.source ?? "(nenhuma fonte externa informada)",
    "",
    "## Restrições",
    ...(pack.constraints.length ? pack.constraints.map((c, i) => `${i + 1}. ${c}`) : ["(nenhuma adicional)"]),
    "1. Não lance outros workers e não delegue sub-tarefas. Você executa o pedido sozinho.",
    "2. Não faça levantamento além do necessário para cumprir o objetivo.",
    "",
    "## Instruções do projeto",
    ...(pack.project_instructions.length
      ? pack.project_instructions.flatMap((f) => [`### ${f.file}`, f.content, ""])
      : ["(o projeto não tem AGENTS.md nem CLAUDE.md)", ""]),
    "## Setup",
    `1. Arrende sua worktree isolada a partir de ${pack.project_path}: \`treehouse get --lease --lease-holder ${taskId}\`. O comando imprime o caminho; entre nele.`,
    `2. Verifique o isolamento com \`pwd -P\` e \`git rev-parse --show-toplevel\`. Os dois devem apontar para a sua worktree, não para ${pack.project_path}. Se não baterem, chame orch_report com status failed e pare.`,
    ...(pack.branch
      ? [`3. Faça checkout da branch \`${pack.branch}\` antes de editar.`]
      : pack.mode === "report"
        ? []
        : ["3. Se o pedido cita uma PR, descubra a branch dela (`gh pr view <número> --json headRefName`) e faça checkout. Sem PR, crie uma branch nova a partir da base."]),
    "",
  ];
  if (pack.spec) lines.push("## Especificação de construção", pack.spec, "");
  lines.push(
    "## Critérios de conclusão",
    ...pack.acceptance.map((a) => `- ${a}`),
    "",
    "## Regras",
    "1. Só faça push ou abra PR conforme o modo. Nunca no checkout principal.",
    "2. Use gh autenticado com a conta certa, conforme as skills de credenciais. Nunca consulte a API sem autenticação.",
    "3. Você não fala com o usuário. Decisão que é do usuário, ou ação destrutiva: chame orch_report com status blocked e question, e encerre o turno.",
    "4. Obstáculo que se repete duas vezes: orch_report com status blocked e o motivo.",
    "5. Não reporte progresso. Chame orch_report uma vez, no fim.",
    "",
    "## Relatório final",
    `Chame orch_report com status (done, failed ou blocked), result (standalone, com evidências) e artifacts (URLs, caminhos). O relatório fica em ${reportPath}.`,
    "",
  );
  return lines.join("\n");
}
