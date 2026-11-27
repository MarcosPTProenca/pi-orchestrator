import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const MODES = ["report", "direct-pr", "design"] as const;
type Tracker = "github" | "plane" | "none";
export type Mode = (typeof MODES)[number];

export interface IntakeInput {
  project_path: string;
  role: string;
  request: string;
  objective: string;
  mode: Mode;
  constraints?: string[];
  source?: string;
  branch?: string;
  spec?: string;
  model?: string;
  tracker?: Tracker;
}

export interface IntakePack {
  project_path: string;
  project_id: string;
  role: string;
  request: string;
  objective: string;
  mode: Mode;
  constraints: string[];
  tracker: Tracker | null;
  source: string | null;
  branch: string | null;
  spec: string | null;
  model: string | null;
  project_instructions: { file: string; content: string }[];
  vision: VisionDoc;
  acceptance: string[];
}

// keep: a visão é a fonte de escopo do projeto; vai inteira (sem corte) ao brief e à revisão de escopo.
export const VISION_FILE = "VISION.md";
export type VisionDoc =
  { status: "present"; content: string } | { status: "missing" } | { status: "unreadable"; reason: string };

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTION_CHARS = 6000;

const PLACEHOLDER = /\{[A-Z][A-Z_]+\}/;

function nonEmpty(field: string, value: string | undefined): string {
  if (!value || value.trim() === "") throw new Error(`${field} vazio`);
  if (PLACEHOLDER.test(value)) throw new Error(`${field} ainda tem placeholder: ${value.match(PLACEHOLDER)?.[0]}`);
  return value.trim();
}

function acceptanceFor(mode: Mode, branch: string | null): string[] {
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
    case "design":
      return [
        "Fluxo de design: `grill-with-docs` (entrevista e glossário), `plan`, `to-spec` (especificação) e `to-tickets` (issues com dependências declaradas).",
        "Discovery com subagents quando precisar de fatos (`researcher`), de evidências em logs (`log-researcher`).",
        "Revisão obrigatória pelo subagent `oracle`, com a regra: features são fatias verticais (tracer bullets) que atravessam todas as camadas e entregam valor sozinhas. Fatia horizontal (só banco, só API, só tela) é reprovada e a correção é pedida ao agente principal antes de seguir.",
        "Entregar o conjunto de issues aprovado pelo usuário, publicado no tracker do projeto. Não publicar nada além do que foi aprovado.",
      ];
  }
}

function readInstructions(projectPath: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const file of PROJECT_FILES) {
    const path = join(projectPath, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    out.push({
      file,
      content: text.length > MAX_INSTRUCTION_CHARS ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[truncado]` : text,
    });
  }
  return out;
}

export function readVision(projectPath: string): VisionDoc {
  const path = join(projectPath, VISION_FILE);
  if (!existsSync(path)) return { status: "missing" };
  try {
    return { status: "present", content: readFileSync(path, "utf8") };
  } catch (err) {
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function buildIntake(input: IntakeInput): IntakePack {
  if (
    !input.project_path.startsWith("/") ||
    !existsSync(input.project_path) ||
    !statSync(input.project_path).isDirectory()
  ) {
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
    tracker: input.tracker ?? null,
    source: input.source?.trim() || null,
    branch,
    spec: input.spec?.trim() ? nonEmpty("spec", input.spec) : null,
    model: input.model ?? null,
    project_instructions: readInstructions(input.project_path),
    vision: readVision(input.project_path),
    acceptance: acceptanceFor(input.mode, branch),
  };
}

function visionSection(vision: VisionDoc): string[] {
  const head = ["## Visão do projeto (VISION.md)"];
  switch (vision.status) {
    case "present":
      return [...head, vision.content, ""];
    case "missing":
      return [...head, "(o projeto não tem VISION.md na raiz; use a spec e o pedido como escopo)", ""];
    case "unreadable":
      return [
        ...head,
        `(o VISION.md existe mas não pôde ser lido: ${vision.reason}; use a spec e o pedido como escopo)`,
        "",
      ];
  }
}

export function renderBrief(
  taskId: string,
  pack: IntakePack,
  reportPath: string,
  worktree: string = pack.project_path,
): string {
  const lines: string[] = [
    `# Tarefa ${taskId} (papel: ${pack.role}, modo: ${pack.mode})`,
    "",
    "Você é um worker: uma sessão autônoma gerenciada pelo orquestrador. Trabalhe sem esperar um humano.",
    "",
    "## O que fazer",
    pack.request,
    "",
    "## Objetivo",
    pack.objective,
    "",
    "## Fonte",
    pack.source ?? "(nenhuma fonte externa informada)",
    `Tracker de issues do projeto: ${pack.tracker ?? "não informado"}.`,
    "",
    "## Restrições",
    ...[
      ...pack.constraints,
      "Não use orch_delegate nem orch_fix_red_prs: não lance outros workers do orquestrador. Subagents internos do Pi e skills são permitidos quando o modo ou o projeto pedirem.",
      "Não faça levantamento além do necessário para cumprir o objetivo.",
      "Coordenar outros agentes, fechar abas ou workers ociosos não é sua tarefa, mesmo que apareça no texto acima. Se ela depender disso, chame orch_report com status blocked.",
    ].map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Instruções do projeto",
    ...(pack.project_instructions.length
      ? pack.project_instructions.flatMap((f) => [`### ${f.file}`, f.content, ""])
      : ["(o projeto não tem AGENTS.md nem CLAUDE.md)", ""]),
    ...visionSection(pack.vision),
    "## Setup",
    `1. Sua worktree isolada já foi arrendada pelo orquestrador e é o diretório de trabalho desta sessão: ${worktree}. Não arrende outra.`,
    `2. Verifique o isolamento com \`pwd -P\` e \`git rev-parse --show-toplevel\`. Os dois devem apontar para ${worktree}, não para ${pack.project_path}. Se não baterem, chame orch_report com status failed e pare.`,
    ...(pack.source && /\/pull\/\d+/.test(pack.source)
      ? [
          "3. Antes de editar, consulte o estado de merge da PR (mergeable e mergeStateStatus, com gh autenticado). Se estiver com conflito, resolva o conflito no branch da PR primeiro. Ao terminar, confirme de novo que ela está mergeável e com checks verdes.",
        ]
      : []),
    ...(pack.branch
      ? [`4. Faça checkout da branch \`${pack.branch}\` antes de editar.`]
      : pack.mode === "report"
        ? []
        : [
            "4. Se o pedido cita uma PR, descubra a branch dela (`gh pr view <número> --json headRefName`) e faça checkout. Sem PR, crie uma branch nova a partir da base.",
          ]),
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
    "6. Não comente nem publique em PR ou issue, a menos que o pedido diga isso.",
    "7. Ao terminar: se não houver alterações nem commits sem push, devolva sua worktree com `treehouse return <caminho>`. Se houver trabalho não enviado, não devolva e informe o caminho no relatório.",
    "8. O campo result é texto para o ORQUESTRADOR ler e decidir como comunicar ao usuário. Nunca se dirija ao usuário em segunda pessoa dentro de result (ex.: 'você precisa decidir', 'cabe a você'). Pendência que depende de decisão humana vai no campo question com status blocked, não escrita dentro de result de status done.",
    "",
    "## Relatório final",
    "Chame orch_report com status (done, failed ou blocked), result e artifacts (URLs, caminhos).",
    "- result: resumo de no máximo 5 linhas, em português, dizendo o que foi feito e o que ficou pendente.",
    `- As evidências completas (comandos, saídas, arquivo:linha) vão no arquivo do relatório, ${reportPath}, não no result.`,
    "",
  );
  return lines.join("\n");
}
