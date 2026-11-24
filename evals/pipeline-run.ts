import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, runDelivery, type RunResult } from "./pipeline/engine.ts";
import { ALL_SCENARIOS } from "./pipeline/scenarios.ts";

const LIMITS = [
  "Fake de GitHub e Herdr: nada é publicado, nenhuma API é chamada, nenhum token é usado.",
  "Fake não prova confiabilidade do GitHub real: latência, eventual consistency, falhas de API e regras de proteção reais não são simulados.",
  "Custos e tokens são constantes por papel (SIMULATED_COST_PER_ROLE), não medição de Pi real.",
  "Lacuna: o fix loop não distingue CI vermelho por bug de erro de infraestrutura; o cenário ci-infra-bounded prova só o limite de ciclos.",
  "Lacuna: aprovação duplicada re-emite 'approved' no fix loop; a deduplicação do merge fica na camada de integração.",
  "Lacuna: ReviewCoordinator e requestIntegration não são alimentados pelo orquestrador em produção; o harness os chama diretamente.",
  "NOT RUN: smoke real opt-in em repo descartável (exige conta de teste e orçamento de tokens definido).",
  "NOT RUN: comparação A/B contra o pi-orch anterior na delegação simples, relatório e status (exige Pi real).",
];

const pad = (s: string | number, n: number): string => String(s).padEnd(n);

async function main(): Promise<void> {
  const results: RunResult[] = [];
  for (const sc of ALL_SCENARIOS) results.push(await runDelivery(sc, mkdtempSync(join(tmpdir(), "pipe-148-"))));

  console.log(
    `${pad("cenário", 22)}${pad("terminal", 18)}${pad("merged", 8)}${pad("rework", 8)}${pad("reviews", 48)}integrações`,
  );
  for (const r of results) {
    const reviews = r.reviews.map((x) => `${x.head.slice(-4)}:${x.verdict}`).join(" ") || "-";
    const integ = r.integrations.map((i) => i.decision).join(" ") || "-";
    console.log(
      `${pad(r.id, 22)}${pad(r.terminal, 18)}${pad(r.terminal === "merged" ? "sim" : "não", 8)}${pad(r.rework, 8)}${pad(reviews, 48)}${integ}`,
    );
  }

  const m = aggregate(results);
  console.log("");
  console.log(`merges indevidas: ${m.improper_merges} (meta 0)`);
  console.log(`merges esperadas que não ocorreram: ${m.missed_merges}`);
  console.log(`aprovação no primeiro review: ${m.first_review_approval.approved}/${m.first_review_approval.of}`);
  console.log(`ciclos de retrabalho: ${m.rework_cycles}`);
  console.log(`cenários que param aguardando humano: ${m.human_stops}/${m.scenarios}`);
  console.log(
    `turnos simulados: ${m.llm_turns} | tokens simulados: ${m.tokens_simulated} | custo simulado: ${m.cost_simulated.toFixed(2)} | duração simulada: ${m.duration_ms_simulated} ms`,
  );
  console.log("");
  console.log("Limites de validade externa:");
  for (const l of LIMITS) console.log(`- ${l}`);

  process.exitCode = m.improper_merges === 0 && m.missed_merges === 0 ? 0 : 1;
}

void main();
