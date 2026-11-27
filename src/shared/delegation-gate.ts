import type { DelegateInput } from "./task.ts";

// keep: gate determinístico do contrato de issue (#240). Confere forma do contrato e cues explícitos; ambiguidade semântica além disso não é pega aqui.
// shortcut: cues de seleção são lista fixa de palavras, sem análise semântica, e a troca de escopo recusa qualquer issue citada; subir para revisão independente (oracle) se um pedido ambíguo passar ou se orientação legítima que cita dependência for bloqueada.
const ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i;
const ISSUE_WORD = /\bissues?\b/i;
const SELECTION =
  /\b(quais|qual|identific\w*|escolh\w*|selecion\w*|sele[cç]\w*|todas (as|os)|todos os|as issues|das issues|nas issues|issues? (visuais|pendentes|abertas|restantes))\b/i;
const IMPLEMENT_CUE =
  /\b(implement\w*|resolv\w*|corrij\w*|public\w*|abr\w*|faç\w*|trabalh\w*|inclu\w*|reatribu\w*|passe a)\b/i;
// keep: "PR #46" e URLs de pull não são issue; sem isso o fix de PR vermelha virava trabalho de issue.
const NOT_ISSUE = /\bPRs?\s*#?\d+\b|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/gi;

// keep: direct-pr concede commit, push e PR (GRANTS/acceptance); restrição do usuário que proíbe isso é conflito explícito, recusado antes do lançamento (#244).
// keep: "não abra outro PR", "não feche PR", "não faça merge" e "não force-push na base" são restrições legítimas de orch_fix_red_prs (prs.ts), não proibição de publicar; PR só conta com verbo de abrir/criar e sem "outro/nova" no meio.
// shortcut: detecção por palavras-chave com negação próxima; uma restrição que cita commit sem proibir publicação pode ser recusada por engano. Subir para parser semântico se isso aparecer.
const PUBLICATION_PROHIBITION =
  /\b(n(ã|a)o|nem|sem|proibid\w*)\b[^.;\n]{0,40}?(\b(commit|(?<!force-)push|publi(c|qu))\w*\b|\b(abr|cri)\w*\b(?:(?!\b(?:outr[oa]s?|nov[oa]s?)\b)[^.;\n]){0,20}?\b(PRs?|pull requests?)\b)/i;

export function publicationConflict(input: Pick<DelegateInput, "mode" | "constraints">): string | null {
  if (input.mode !== "direct-pr") return null;
  const blocking = (input.constraints ?? []).filter((c) => PUBLICATION_PROHIBITION.test(c));
  if (blocking.length === 0) return null;
  return `delegação recusada antes do lançamento: a restrição "${blocking.join('", "')}" proíbe commit, push ou PR, mas o modo direct-pr exige publicação. Para manter a restrição, delegue em modo report (pesquisa, sem publicação); para publicar, remova a restrição. Nada foi lançado.`;
}

export function issueNumberOf(source: string | null | undefined): number | null {
  const m = ISSUE_URL.exec((source ?? "").trim());
  return m ? Number(m[3]) : null;
}

function repoOfIssue(source: string): string | null {
  const m = ISSUE_URL.exec(source.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function issueRefs(text: string): Set<number> {
  const clean = text.replace(NOT_ISSUE, " ");
  const found = new Set<number>();
  for (const m of clean.matchAll(/\/issues\/(\d+)/g)) found.add(Number(m[1]));
  for (const m of clean.matchAll(/#(\d+)\b/g)) found.add(Number(m[1]));
  return found;
}

export function repoFromRemote(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function isIssueWork(input: Pick<DelegateInput, "mode" | "source" | "request" | "objective">): boolean {
  if (input.mode !== "direct-pr") return false;
  return issueNumberOf(input.source) !== null || ISSUE_WORD.test(`${input.request}\n${input.objective ?? ""}`);
}

export function checkIssueDelegation(input: DelegateInput, originRepo: string | null): string | null {
  if (!isIssueWork(input)) return null;
  const problems: string[] = [];
  const own = issueNumberOf(input.source);
  const source = input.source?.trim() ?? "";
  if (own === null) {
    problems.push(
      source === ""
        ? "source ausente: informe a URL da issue (https://github.com/<dono>/<repo>/issues/<n>)"
        : `source (${source}) não é a URL canônica de uma issue: use https://github.com/<dono>/<repo>/issues/<n>`,
    );
  } else {
    const others = [...issueRefs(`${input.request}\n${input.objective ?? ""}`)].filter((n) => n !== own);
    if (others.length > 0)
      problems.push(
        `o pedido cita outra issue (#${others.join(", #")}); um worker executa uma issue só: delegue cada uma separadamente`,
      );
    const srcRepo = repoOfIssue(source);
    if (originRepo && srcRepo && srcRepo !== originRepo)
      problems.push(`source é do repositório ${srcRepo}, mas o origin do projeto é ${originRepo}`);
  }
  if (SELECTION.test(input.request))
    problems.push(
      "pedido de seleção não resolvido (trabalho de escolher issues, não de uma issue): escolha a issue antes e delegue a específica",
    );
  if (!input.acceptance || input.acceptance.length === 0)
    problems.push("critérios de aceite ausentes: informe acceptance com critérios verificáveis da issue");
  if (problems.length === 0) return null;
  return `delegação de implementação por issue recusada antes do lançamento: ${problems.join("; ")}.`;
}

export function issueSendScope(
  task: { source: string | null | undefined; mode: string | null | undefined },
  text: string,
): string | null {
  const own = issueNumberOf(task.source);
  if (own === null) return null;
  const others = [...issueRefs(text)].filter((n) => n !== own);
  if (others.length === 0) return null;
  // keep: pesquisa pode comparar com outra issue; só a menção acompanhada de ação de implementação é troca de escopo.
  if (task.mode !== "direct-pr" && !IMPLEMENT_CUE.test(text)) return null;
  return `troca de escopo recusada: a tarefa é da issue #${own} e o texto cita #${others.join(", #")}. Outra issue exige nova delegação com orch_delegate; nada foi enviado.`;
}
