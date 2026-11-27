import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { maskSecrets } from "../shared/logs.ts";

export type PlanFailure = { at: string; where: string; plan_id: string | null; error: string };

export function planFailureRecord(where: string, planId: string | null, err: unknown): PlanFailure {
  const text = err instanceof Error ? err.message : String(err);
  return { at: new Date().toISOString(), where, plan_id: planId, error: maskSecrets(text).slice(0, 300) };
}

// keep: a chave guarda só o episódio de falha atual; um sucesso a limpa, então a próxima falha volta a avisar.
export class PlanFailureWatch {
  private active = new Set<string>();

  fail(key: string): boolean {
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  ok(key: string): void {
    this.active.delete(key);
  }
}

// keep: o registro vai para arquivo; se a escrita falhar, cai no stderr em vez de sumir, e nunca interrompe o ciclo.
export function writePlanFailure(file: string, failure: PlanFailure): void {
  const line = `${JSON.stringify(failure)}\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch {
    process.stderr.write(line);
  }
}

// keep: falha de um passo do ciclo vira registro e aviso, sem propagar; o próximo passo e o próximo ciclo seguem.
export async function guardPlanStep(
  watch: PlanFailureWatch,
  key: string,
  where: string,
  planId: string | null,
  step: () => void | Promise<void>,
  onFirstFailure: (failure: PlanFailure) => void,
): Promise<void> {
  try {
    await step();
    watch.ok(key);
  } catch (err) {
    if (watch.fail(key)) onFirstFailure(planFailureRecord(where, planId, err));
  }
}
