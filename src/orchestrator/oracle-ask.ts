import { latestAsk, recordOracleVerdict } from "../shared/ask.ts";

// keep: só estes vereditos chegam do Oracle; "failed" é gravado pelo orquestrador quando o parecer não serve.
const ANSWER_VERDICTS = ["answered", "inconclusive", "contradictory", "out_of_scope"] as const;
const MAX_CLIP = 600;
const MAX_OBJECTIVE = 300;

export interface OracleAskContext {
  taskId: string;
  askId: string;
  question: string;
  askContext: string;
  projectLabel: string;
  projectPath: string;
  objective: string;
  source: string | null;
  visionPath: string;
}

export interface OracleAnswer {
  verdict: (typeof ANSWER_VERDICTS)[number];
  answer: string | null;
  reason: string;
  uncertainty: string;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)} [truncado]` : text);

// keep: contrato enxuto para o Oracle: pergunta, contexto que o worker já verificou e ponteiros para spec; a conversa do worker nunca entra.
export function oracleContract(c: OracleAskContext): string {
  return [
    `- Pergunta do worker (tarefa ${c.taskId}, projeto ${c.projectLabel}): ${clip(c.question, MAX_CLIP)}`,
    `- Contexto que o worker já verificou: ${clip(c.askContext || "(nenhum)", MAX_CLIP)}`,
    `- Objetivo da tarefa: ${clip(c.objective || "(não informado)", MAX_OBJECTIVE)}`,
    `- Spec ou ticket de origem: ${c.source ?? "(nenhuma informada)"}`,
    `- Repositório: ${c.projectPath}. Visão do projeto, se existir: ${c.visionPath} (leia só se precisar).`,
    "- Investigue só o necessário, em modo somente leitura (read, grep, find, ls, git log, git diff, git show). Não edite arquivos, não altere estado e não decida merge.",
    '- Responda só em JSON: {"verdict":"answered|inconclusive|contradictory|out_of_scope","answer":"orientação em uma frase, se answered","reason":"racional curto","uncertainty":"o que não foi possível confirmar"}.',
    '- "answered" só quando a spec ou o código sustentam a orientação. "out_of_scope" quando responder exigiria mudar o escopo. "contradictory" quando spec e código divergem. "inconclusive" quando não dá para concluir.',
  ].join("\n");
}

export function parseOracleAnswer(raw: string): OracleAnswer {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      'parecer precisa ser JSON: {"verdict":"answered|inconclusive|contradictory|out_of_scope","answer":"...","reason":"...","uncertainty":"..."}',
    );
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  if (typeof o.verdict !== "string" || !(ANSWER_VERDICTS as readonly string[]).includes(o.verdict))
    throw new Error(`verdict inválido: use ${ANSWER_VERDICTS.join(", ")}`);
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const verdict = o.verdict as OracleAnswer["verdict"];
  const answer = text(o.answer);
  if (verdict === "answered" && answer === "") throw new Error("answer obrigatório quando verdict é answered");
  const reason = text(o.reason);
  if (reason === "") throw new Error("reason obrigatório");
  return {
    verdict,
    answer: verdict === "answered" ? answer.slice(0, MAX_CLIP) : null,
    reason: reason.slice(0, MAX_CLIP),
    uncertainty: text(o.uncertainty).slice(0, MAX_CLIP),
  };
}

export interface SettleInput {
  taskId: string;
  taskDir: string;
  askId: string;
  raw: string;
}

// keep: a pergunta só é consultada uma vez; falha de formato também conta, para o ciclo de consultas não ser indefinido.
export function settleOracleVerdict(input: SettleInput): string {
  const latest = latestAsk(input.taskDir);
  if (!latest || latest.id !== input.askId)
    throw new Error(`pergunta ${input.askId} não é a atual da tarefa ${input.taskId}; nada foi registrado`);
  let parsed: OracleAnswer | null = null;
  let failure = "";
  try {
    parsed = parseOracleAnswer(input.raw);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const verdict = parsed?.verdict ?? "failed";
  if (!recordOracleVerdict(input.taskDir, input.askId, verdict))
    throw new Error(`já há parecer para a pergunta ${input.askId}; não consulte de novo: escale ao usuário`);
  const escalate = `Para o worker encerrar sem decidir, orch_send(task_id="${input.taskId}", text=<instrução para orch_report status blocked com a pergunta>) sem ask_id, e informe o usuário da pergunta e do task_id.`;
  if (!parsed)
    return `Oracle não entregou parecer válido (${failure}). Consulta encerrada: não consulte de novo. ${escalate}`;
  if (parsed.verdict === "answered")
    return [
      `Parecer answered registrado para a pergunta ${input.askId}. Orientação: "${parsed.answer}". Incerteza: ${parsed.uncertainty || "nenhuma informada"}.`,
      `Valide se a orientação cabe no escopo da spec, da VISION ou do pedido. Se couber: orch_send(task_id="${input.taskId}", ask_id="${input.askId}", text=<orientação>). Se não couber: não responda; informe o usuário. ${escalate}`,
    ].join(" ");
  return `Parecer ${parsed.verdict} registrado: não autoriza resposta (${parsed.reason}). Não use orch_send com ask_id. ${escalate}`;
}
