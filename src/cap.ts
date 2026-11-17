/**
 * Teto global de workers ativos (starting, running, blocked), somando orch_delegate e orch_fix_red_prs.
 * Sem teto, um lote grande ou repetido pode lançar mais workers do que a máquina e a cota aguentam.
 */
export const DEFAULT_MAX_ACTIVE = 6;
const MAX_ALLOWED = 50;

export function maxActiveFrom(env: string | undefined): number {
  if (env === undefined || !/^\d+$/.test(env.trim())) return DEFAULT_MAX_ACTIVE;
  const n = Number(env.trim());
  return n >= 1 && n <= MAX_ALLOWED ? n : DEFAULT_MAX_ACTIVE;
}

/** Mensagem de recusa se somar `adding` ao `active` estoura o teto; null se cabe. */
export function capError(active: number, adding: number, cap: number): string | null {
  if (active + adding <= cap) return null;
  return `teto de workers ativos: há ${active} ativos, o pedido traz ${adding} e o teto é ${cap}. Nada foi lançado. Aguarde uma tarefa terminar, cancele alguma, ou aumente o teto com PI_ORCH_MAX_ACTIVE.`;
}
