import type { DiagnosisSource, EvidenceLevel, LostDiagnosis, TaskRecord } from "../shared/contract.ts";
import type { PublishState } from "../shared/publish.ts";

// keep: fatos já coletados do disco e do git; a classificação é pura e nunca muda o status da tarefa.
export type ReportFact =
  | { state: "ausente" }
  | { state: "invalido"; detail: string }
  | { state: "valido"; status: "done" | "blocked" | "failed"; result: string };

export type WorktreeFact =
  | { state: "ausente" }
  | { state: "indisponivel"; detail: string }
  | {
      state: "encontrada";
      path: string;
      head: string | null;
      dirty: boolean;
      pushed: boolean;
      unpushed: number;
    };

export interface DiagnosisFacts {
  now: string;
  task: TaskRecord;
  report: ReportFact;
  publish: PublishState | null;
  publishError: string | null;
  worktree: WorktreeFact;
  session: string | null;
  pane: "ausente" | "trocou";
  prUrl: string | null;
}

const EXCERPT = 160;

function clip(text: string): string {
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

export function diagnoseLostTask(f: DiagnosisFacts): LostDiagnosis {
  const t = f.task;
  const sources: DiagnosisSource[] = [];
  const evidence: string[] = [];
  const pending: string[] = [];
  const paneText =
    f.pane === "trocou"
      ? "painel trocou de agente: nada lido"
      : "painel não existe mais: leitura do Herdr indisponível";

  const branch = f.publish?.branch ?? t.branch ?? null;
  const last = t.result && t.result.trim() !== "" ? t.result : null;
  sources.push({
    source: "estado",
    state: f.publishError ? "indisponivel" : "verificada",
    detail: `status ${t.status} desde ${t.updated_at}${branch ? `; branch ${branch}` : ""}${f.publishError ? `; publish-state ilegível: ${f.publishError}` : ""}`,
  });
  if (f.publishError) pending.push("estado de publicação ilegível: commit ou PR pode existir sem constar aqui");
  if (last) evidence.push(`último relato da tarefa: ${clip(last)}`);

  if (f.report.state === "valido") {
    sources.push({
      source: "relatorio",
      state: "verificada",
      detail: `relatório ${f.report.status}: ${clip(f.report.result)}`,
    });
    evidence.push(`relatório ${f.report.status} gravado pelo worker`);
  } else if (f.report.state === "invalido") {
    sources.push({ source: "relatorio", state: "indisponivel", detail: `relatório ilegível: ${f.report.detail}` });
    pending.push("relatório ilegível: o resultado não pode ser confirmado");
  } else {
    sources.push({ source: "relatorio", state: "ausente", detail: "sem report.json" });
    pending.push("relatório final ausente");
  }

  if (f.session) {
    sources.push({ source: "logs", state: "verificada", detail: `sessão do worker em ${f.session}; ${paneText}` });
  } else {
    sources.push({ source: "logs", state: "ausente", detail: `sem sessão gravada; ${paneText}` });
    pending.push(`logs do worker indisponíveis (${paneText})`);
  }

  let commitUnpushed: { sha: string; path: string } | null = null;
  const base = f.publish?.base_sha ?? null;
  if (f.worktree.state === "encontrada") {
    const w = f.worktree;
    sources.push({
      source: "worktree",
      state: "verificada",
      detail: `${w.path}; HEAD ${w.head ? short(w.head) : "desconhecido"}; alterações não commitadas: ${w.dirty ? "sim" : "não"}; commits não publicados: ${w.unpushed}`,
    });
    if (w.dirty) evidence.push(`alterações não commitadas em ${w.path}`);
    // keep: commit não publicado vem do git (sem remoto que o contenha), não de publish-state.json; sem ele o diagnóstico cairia em none.
    if (w.head && w.unpushed > 0) {
      evidence.push(`commit ${short(w.head)} criado na worktree, não publicado`);
      commitUnpushed = { sha: w.head, path: w.path };
    } else if (w.head && base && w.head !== base && w.pushed) {
      evidence.push(`commit ${short(w.head)} criado na worktree, publicado`);
    }
  } else if (f.worktree.state === "indisponivel") {
    sources.push({ source: "worktree", state: "indisponivel", detail: f.worktree.detail });
    pending.push(`worktree não verificada: ${f.worktree.detail}`);
  } else {
    sources.push({ source: "worktree", state: "ausente", detail: "nenhuma worktree arrendada para a tarefa" });
  }

  const prUrl = f.prUrl ?? f.publish?.pr_url ?? null;
  if (prUrl) {
    sources.push({
      source: "pr",
      state: "verificada",
      detail: `${prUrl} registrada no estado (checks não consultados)`,
    });
    evidence.push(`PR ${prUrl}`);
    pending.push("checks da PR não consultados neste diagnóstico");
  } else {
    sources.push({ source: "pr", state: "ausente", detail: "nenhuma PR registrada" });
  }

  const level: EvidenceLevel =
    f.report.state === "valido" && f.report.status === "done" ? "verified" : evidence.length > 0 ? "partial" : "none";
  if (level === "none") {
    pending.push("nenhuma fonte consultada trouxe evidência; isso não prova que a tarefa não avançou");
  }

  let recovery: string;
  if (level === "verified") {
    recovery =
      "relatório done já gravado: a tarefa não foi marcada como concluída; a entrega passa pelos gates antes. Nada foi relançado.";
  } else if (commitUnpushed) {
    recovery = `inspecione a worktree ${commitUnpushed.path} e o commit ${short(commitUnpushed.sha)} antes de agir; publicar ou relançar (orch_relaunch) depende da sua autorização. Nada foi relançado.`;
  } else if (level === "partial") {
    recovery =
      "confira a worktree e os artefatos acima antes de decidir; retomar (orch_relaunch) depende da sua autorização. Nada foi relançado.";
  } else {
    recovery =
      "confira a worktree manualmente; relançar (orch_relaunch) depende da sua autorização. Nada foi relançado.";
  }

  return {
    level,
    last_status: t.status,
    last_seen_at: t.updated_at,
    sources,
    evidence,
    pending,
    recovery,
    diagnosed_at: f.now,
  };
}

// keep: a ação segura vem antes das pendências; orch_status corta o erro em 300 caracteres e a ação não pode sair cortada.
export function lostSummary(d: LostDiagnosis): string {
  const ev = d.evidence.length > 0 ? d.evidence.join("; ") : "nenhuma evidência nas fontes consultadas";
  const pend = d.pending.length > 0 ? ` Pendências: ${d.pending.join("; ")}.` : "";
  return `Diagnóstico (${d.level}). Ação segura: ${d.recovery} Evidências: ${ev}.${pend}`;
}
