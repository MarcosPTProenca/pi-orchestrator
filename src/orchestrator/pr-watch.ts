import { FAILING, type PrState } from "../shared/prs.ts";
import type { TaskRecord } from "../shared/contract.ts";

export type PrVerdict = "merged" | "conflict" | "open" | "pending";

export function prVerdict(s: PrState): PrVerdict {
  if (s.state === "MERGED") return "merged";
  if (s.mergeable === "CONFLICTING" || s.mergeStateStatus === "DIRTY") return "conflict";
  if (s.mergeable === "UNKNOWN") return "pending";
  return "open";
}

// keep: uma chave por evento lógico (tarefa+PR+head+tipo); a claim é síncrona, então a primeira checagem vence.
export class NoticeClaims {
  private claimed = new Set<string>();

  claim(key: string): boolean {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  release(key: string): void {
    this.claimed.delete(key);
  }
}

export function mergedNoticeKey(taskId: string, prUrl: string, headSha: string): string {
  return `${taskId}|merged|${prUrl}|${headSha}`;
}

export function prUrlOf(t: { source?: string | null; artifacts?: string[] }): string | null {
  const isPr = (u: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u);
  if (t.source && isPr(t.source)) return t.source;
  const prs = (t.artifacts ?? []).filter(isPr);
  const repo = t.source?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/)?.[1];
  return (repo && prs.find((u) => u.startsWith(`https://github.com/${repo}/pull/`))) ?? prs[0] ?? null;
}

export function isPrWatched(
  t: Pick<TaskRecord, "status" | "notified" | "tab_id"> & { source?: string | null; artifacts?: string[] },
): boolean {
  return t.status === "done" && t.notified && prUrlOf(t) !== null && !!t.tab_id;
}

export type PrAction = "conflict" | "ci";

export function classifyCiFailure(log: string | null): { kind: "code" | "infra" | "flaky"; reason: string } {
  if (!log?.trim())
    return { kind: "infra", reason: "log de falha indisponível ou vazio; sem evidência para atribuir ao código" };
  if (
    /runner (?:was )?offline|no available runner|timed? ?out|network (?:error|failure)|connection reset|502|503|504|service unavailable|internal server error|rate limit|resource not accessible/i.test(
      log,
    )
  ) {
    return { kind: "infra", reason: "log indica falha de infraestrutura externa ou timeout" };
  }
  if (/flaky|intermittent|passed on retry|retry succeeded/i.test(log)) {
    return { kind: "flaky", reason: "log indica falha flaky/intermitente" };
  }
  return { kind: "code", reason: "log contém falha sem marcador conhecido de infraestrutura ou flaky" };
}

export function failingChecks(s: PrState): string[] {
  return [
    ...new Set(
      s.checks.filter((c) => c.conclusion !== null && FAILING.has(c.conclusion.toUpperCase())).map((c) => c.name),
    ),
  ];
}

export class PrActionWatch {
  private acted = new Map<string, string>();

  shouldAct(taskId: string, headOid: string, active: boolean, kind: PrAction): boolean {
    const key = `${taskId}|${kind}`;
    if (!active) {
      this.acted.delete(key);
      return false;
    }
    return this.acted.get(key) !== headOid;
  }

  markActed(taskId: string, headOid: string, kind: PrAction): void {
    this.acted.set(`${taskId}|${kind}`, headOid);
  }

  forget(taskId: string): void {
    for (const kind of ["conflict", "ci"] as const) this.acted.delete(`${taskId}|${kind}`);
  }
}

export function conflictInstruction(prUrl: string): string {
  return [
    `A PR ${prUrl} está com conflito de merge com a base. Atualize a branch com a base (git merge origin/<base>),`,
    "resolva os conflitos preservando a intenção de cada lado, rode os mesmos checks do CI localmente e envie o push",
    "para a mesma branch. Não reescreva histórico nem faça force-push. Se o conflito exigir decisão de produto, pare e diga",
    "quais arquivos conflitam e por quê.",
  ].join(" ");
}

export function ciInstruction(prUrl: string, failing: string[]): string {
  return [
    `A PR ${prUrl} tem checks do CI falhando: ${failing.join(", ")}.`,
    "Leia o log da falha (gh run view <id> --log-failed), corrija a causa na mesma branch, rode localmente os checks que",
    "falharam e envie o push. Não reescreva histórico nem faça force-push. Se a falha for de infraestrutura externa,",
    "não relacionada à mudança, diga qual é a evidência e pare. Se não houver log legível, a falha for flaky ou o log não",
    "apontar código seu, não edite por palpite: diga a evidência e pare.",
  ].join(" ");
}
