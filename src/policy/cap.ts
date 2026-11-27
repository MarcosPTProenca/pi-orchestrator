const DEFAULT_MAX_ACTIVE = 8;
const MAX_ALLOWED = 50;

export function maxActiveFrom(env: string | undefined): number {
  if (env === undefined || !/^\d+$/.test(env.trim())) return DEFAULT_MAX_ACTIVE;
  const n = Number(env.trim());
  return n >= 1 && n <= MAX_ALLOWED ? n : DEFAULT_MAX_ACTIVE;
}

// keep: vagas livres para o avanço automático de plano; sem vaga o item fica pendente, sem bloquear.
export function launchRoom(cap: number, active: number): number {
  return Math.max(0, cap - active);
}

export function capError(active: number, adding: number, cap: number): string | null {
  if (active + adding <= cap) return null;
  return `teto de workers ativos: há ${active} ativos, o pedido traz ${adding} e o teto é ${cap}. Nada foi lançado. Aguarde uma tarefa terminar, cancele alguma, ou aumente o teto com PI_ORCH_MAX_ACTIVE.`;
}
