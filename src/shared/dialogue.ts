// keep: orçamento do diálogo autônomo conta só perguntas operacionais entregues ao orquestrador; sem métrica de custo, o contador de perguntas é o que vale.
export const DIALOGUE_BUDGET_DEFAULT = 3;
const DIALOGUE_BUDGET_MAX = 10;
const HISTORY_CHARS = 300;

export type AskVerdict = "progress" | "redirect" | "no_progress" | "exhausted";

interface DialogueAskRecord {
  question: string;
  context: string;
  verdict: AskVerdict;
}

export interface DialogueRecord {
  budget: number;
  // keep: spent só cresce quando a pergunta é entregue ao orquestrador; pergunta parada não consome.
  spent: number;
  // keep: a estratégia nova é oferecida uma vez por tarefa; depois dela, repetição sem evidência bloqueia.
  redirected: boolean;
  asks: DialogueAskRecord[];
}

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// keep: ambiente inválido cai no padrão; valor explícito por tarefa inválido é recusado, para não ser ignorado em silêncio.
export function resolveDialogueBudget(explicit: unknown, env: string | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || (explicit as number) < 1 || (explicit as number) > DIALOGUE_BUDGET_MAX)
      throw new Error(`dialogue_budget deve ser inteiro entre 1 e ${DIALOGUE_BUDGET_MAX}`);
    return explicit as number;
  }
  if (env === undefined || !/^\d+$/.test(env.trim())) return DIALOGUE_BUDGET_DEFAULT;
  const n = Number(env.trim());
  return n >= 1 && n <= DIALOGUE_BUDGET_MAX ? n : DIALOGUE_BUDGET_DEFAULT;
}

export function newDialogue(budget: number): DialogueRecord {
  return { budget, spent: 0, redirected: false, asks: [] };
}

// keep: repetição é a mesma pergunta com o mesmo contexto verificado; contexto novo é evidência nova e segue como progresso.
export function judgeAsk(d: DialogueRecord, ask: { question: string; context: string }): AskVerdict {
  if (d.spent >= d.budget) return "exhausted";
  const q = normalize(ask.question);
  const c = normalize(ask.context);
  const same = d.asks.filter((a) => normalize(a.question) === q);
  if (same.length === 0 || !same.some((a) => normalize(a.context) === c)) return "progress";
  return d.redirected ? "no_progress" : "redirect";
}

export function recordAsk(
  d: DialogueRecord,
  ask: { question: string; context: string },
  verdict: AskVerdict,
): DialogueRecord {
  const delivered = verdict === "progress" || verdict === "redirect";
  return {
    ...d,
    spent: delivered ? d.spent + 1 : d.spent,
    redirected: d.redirected || verdict === "redirect",
    asks: [
      ...d.asks,
      {
        question: ask.question.slice(0, HISTORY_CHARS),
        context: ask.context.slice(0, HISTORY_CHARS),
        verdict,
      },
    ],
  };
}

export function redirectHint(d: DialogueRecord): string {
  return `Pergunta repetida sem evidência nova. Você pode oferecer UMA estratégia nova, baseada em evidência verificável (orch_send com ask_id só depois de parecer answered do Oracle). Se a próxima pergunta vier igual, a tarefa será bloqueada para decisão humana. Gasto do diálogo: ${d.spent}/${d.budget}.`;
}

// keep: o resumo do bloqueio precisa bastar para a decisão humana: tentativas, saldo e a pergunta concreta; nunca declara sucesso.
// keep: o motivo do bloqueio sai daqui para o resumo e para a cronologia, para ficarem iguais.
export function stopReason(d: DialogueRecord, verdict: AskVerdict): string {
  return verdict === "exhausted"
    ? `orçamento de ${d.budget} perguntas operacionais esgotado`
    : `a pergunta voltou com o mesmo contexto, sem evidência nova, depois da estratégia redirecionada`;
}

export function stopSummary(
  d: DialogueRecord,
  ask: { question: string; context: string },
  verdict: AskVerdict,
  discarded: { id: string; question: string } | null = null,
): string {
  const left = Math.max(d.budget - d.spent, 0);
  const tried = d.asks.map((a, i) => `${i + 1}) ${a.question}`).join(" ");
  const dropped = discarded
    ? ` Pergunta anterior sem resposta descartada (${discarded.id}): "${discarded.question.slice(0, HISTORY_CHARS)}".`
    : "";
  return [
    `Diálogo autônomo parado: ${stopReason(d, verdict)} (gasto ${d.spent}/${d.budget}; ${left} restantes).${dropped}`,
    `Tentativas: ${tried || "nenhuma"}.`,
    `Evidência mais recente: ${ask.context.slice(0, HISTORY_CHARS) || "(nenhuma)"}.`,
    `Decisão necessária: orientar o worker sobre "${ask.question.slice(0, HISTORY_CHARS)}". Responda com orch_answer ou cancele com orch_cancel; nada foi declarado concluído.`,
  ].join(" ");
}
