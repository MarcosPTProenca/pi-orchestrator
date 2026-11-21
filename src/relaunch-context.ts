import type { FailureKind } from "./failure.ts";

export const RELAUNCH_MARK = "Tentativa anterior (";
export const HANDOFF_EXCERPT_CHARS = 2000;

const GUARD =
  "Confira o que já existe (worktree, commits, PR) antes de refazer; não repita comandos com efeito externo já executados.";

export type RelaunchContext = "fork-with-history" | "fresh-with-handoff";

export function relaunchContext(sessionFile: string | null): RelaunchContext {
  return sessionFile ? "fork-with-history" : "fresh-with-handoff";
}

export interface RelaunchNoticeInput {
  taskId: string;
  context: RelaunchContext;
  kind: FailureKind;
  reportPath: string;
  report: string;
  branch: string | null;
  artifacts: string[];
}

function tail(text: string, max = HANDOFF_EXCERPT_CHARS): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export function relaunchNotice(input: RelaunchNoticeInput): string {
  const head = `${RELAUNCH_MARK}${input.taskId}) falhou.`;
  if (input.context === "fork-with-history") {
    return [
      head,
      "A conversa da tentativa anterior foi copiada para esta sessão: leia o histórico antes de refazer.",
      `Relatório completo (não reimpresso aqui): ${input.reportPath}.`,
      GUARD,
    ].join(" ");
  }
  const artifacts = input.artifacts.length ? input.artifacts.join(", ") : "nenhum";
  return [
    head,
    "Sem conversa da tentativa anterior disponível.",
    `Classe da falha: ${input.kind}. Branch: ${input.branch ?? "não informada"}. Artefatos: ${artifacts}.`,
    `Relatório completo: ${input.reportPath}. Trecho final:\n${tail(input.report) || "sem detalhe"}`,
    GUARD,
  ].join("\n");
}
