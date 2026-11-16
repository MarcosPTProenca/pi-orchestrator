/**
 * Cenários de comportamento do orquestrador. Cada cenário dá um pedido em linguagem natural
 * e checa o que o orquestrador FEZ: tools, parâmetros, modelo, contexto e perguntas.
 */
export interface Run {
  calls: { name: string; args: Record<string, unknown> }[];
  results: { name: string; isError: boolean; text: string }[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  finalText: string;
  models: Set<string>;
}

export interface Tasks {
  count: number;
  models: (string | null)[];
  modes: string[];
  briefs: string[];
  projects: string[];
}

export type Check = (run: Run, tasks: Tasks) => { name: string; ok: boolean; detail: string };

export interface Scenario {
  id: string;
  prompt: (fx: Record<string, string>) => string;
  checks: Check[];
}

const delegateCalls = (run: Run) => run.calls.filter((c) => c.name === "orch_delegate");
const itemsOf = (run: Run): Record<string, unknown>[] =>
  delegateCalls(run).flatMap((c) => (Array.isArray(c.args.tasks) ? (c.args.tasks as Record<string, unknown>[]) : []));
const forbidden = ["bash", "read", "grep", "find", "ls", "edit", "write", "subagent"];

export const scenarios: Scenario[] = [
  {
    id: "dois-trabalhos-independentes",
    prompt: (fx) =>
      `Lance dois workers independentes, em paralelo, com o modelo claude-bridge/claude-haiku-5-5. ` +
      `Worker 1: no projeto ${fx.alpha}, resumir o README em uma frase. Worker 2: no projeto ${fx.beta}, resumir o README em uma frase. ` +
      `Modo: só relatório, sem alterar nada.`,
    checks: [
      (run, t) => ({ name: "exatamente 2 workers criados", ok: t.count === 2, detail: `criados=${t.count}` }),
      (run) => ({ name: "os 2 em uma única chamada orch_delegate", ok: delegateCalls(run).length === 1, detail: `chamadas=${delegateCalls(run).length}` }),
      (run) => ({ name: "modelo pedido nos 2", ok: itemsOf(run).length === 2 && itemsOf(run).every((i) => i.model === "claude-bridge/claude-haiku-5-5"), detail: JSON.stringify(itemsOf(run).map((i) => i.model)) }),
      (run) => ({ name: "modo report nos 2", ok: itemsOf(run).every((i) => i.mode === "report"), detail: JSON.stringify(itemsOf(run).map((i) => i.mode)) }),
      (_r, t) => ({ name: "projetos corretos", ok: t.projects.some((p) => p.endsWith("alpha")) && t.projects.some((p) => p.endsWith("beta")), detail: JSON.stringify(t.projects) }),
      (run) => ({ name: "request é o trabalho, sem instruções de lançamento", ok: itemsOf(run).every((i) => !/\blance\b|claude-bridge|\bworkers?\b/i.test(String(i.request))), detail: JSON.stringify(itemsOf(run).map((i) => i.request)) }),
      (_r, t) => ({ name: "brief leva o pedido literal (alpha e beta)", ok: t.briefs.every((b) => /## Pedido do usuário \(literal\)/.test(b)) && t.briefs.some((b) => /alpha/.test(b)) && t.briefs.some((b) => /beta/.test(b)), detail: "ver brief" }),
      (_r, t) => ({ name: "brief leva instruções do projeto (AGENTS.md)", ok: t.briefs.every((b) => /Commits em português/.test(b)), detail: "AGENTS.md ausente no brief" }),
      (run) => ({ name: "sem pesquisa nem ferramentas proibidas", ok: !run.calls.some((c) => forbidden.includes(c.name)), detail: run.calls.map((c) => c.name).join(",") }),
      (run) => ({ name: "sem perguntas desnecessárias", ok: !run.calls.some((c) => c.name === "AskUserQuestion"), detail: "AskUserQuestion chamado" }),
    ],
  },
  {
    id: "modelo-indisponivel",
    prompt: (fx) =>
      `Lance um worker no projeto ${fx.alpha} com o modelo claude-bridge/modelo-que-nao-existe para resumir o README.`,
    checks: [
      (_r, t) => ({ name: "nenhum worker criado", ok: t.count === 0, detail: `criados=${t.count}` }),
      (run) => ({ name: "erro explícito da validação de modelo", ok: run.results.some((r) => r.isError && /modelo indisponível/.test(r.text)), detail: run.results.map((r) => r.text.slice(0, 120)).join(" | ") }),
      (run) => ({ name: "não trocou por outro modelo", ok: !itemsOf(run).some((i) => i.model && i.model !== "claude-bridge/modelo-que-nao-existe"), detail: "" }),
    ],
  },
  {
    id: "prs-vermelhas-sem-remote",
    prompt: (fx) =>
      `Resolva as PRs vermelhas do repositório ${fx.alpha}, com claude-bridge/claude-haiku-5-5, dois por vez.`,
    checks: [
      (run) => ({ name: "usou orch_fix_red_prs com o repositório e o modelo", ok: run.calls.some((c) => c.name === "orch_fix_red_prs" && String(c.args.repo_path).endsWith("alpha") && c.args.model === "claude-bridge/claude-haiku-5-5"), detail: JSON.stringify(run.calls.map((c) => [c.name, c.args])) }),
      (run) => ({ name: "não lançou PR por PR com orch_delegate", ok: delegateCalls(run).length === 0, detail: `chamadas=${delegateCalls(run).length}` }),
      (_r, t) => ({ name: "nenhum worker criado (sem remote, sem PRs)", ok: t.count === 0, detail: `criados=${t.count}` }),
      (run) => ({ name: "não inventou PRs na resposta final", ok: !/PR #\d+/.test(run.finalText) || run.results.some((r) => r.isError), detail: run.finalText.slice(0, 160) }),
    ],
  },
  {
    id: "consulta-sem-lancar",
    prompt: () => `Quantos workers estão ativos agora?`,
    checks: [
      (run) => ({ name: "consultou o estado (orch_status)", ok: run.calls.some((c) => c.name === "orch_status"), detail: run.calls.map((c) => c.name).join(",") }),
      (run) => ({ name: "não lançou nenhum worker", ok: delegateCalls(run).length === 0, detail: "" }),
    ],
  },
  {
    id: "sem-projeto-nao-inventa",
    prompt: () => `Lance um worker para corrigir o bug de login.`,
    checks: [
      (_r, t) => ({ name: "não lançou worker com projeto inventado", ok: t.count === 0, detail: `criados=${t.count} em ${JSON.stringify(t.projects)}` }),
    ],
  },
  {
    id: "um-worker-sem-pesquisa",
    prompt: (fx) => `Lance um worker no projeto ${fx.alpha} para resumir o README em uma frase, modo relatório, com claude-bridge/claude-haiku-5-5.`,
    checks: [
      (_r, t) => ({ name: "exatamente 1 worker", ok: t.count === 1, detail: `criados=${t.count}` }),
      (run) => ({ name: "modelo pedido", ok: itemsOf(run).every((i) => i.model === "claude-bridge/claude-haiku-5-5"), detail: "" }),
      (run) => ({ name: "request é o trabalho, sem instruções de lançamento", ok: itemsOf(run).every((i) => !/\blance\b|claude-bridge/i.test(String(i.request))), detail: JSON.stringify(itemsOf(run).map((i) => i.request)) }),
      (run) => ({ name: "sem pesquisa prévia", ok: !run.calls.some((c) => forbidden.includes(c.name)), detail: run.calls.map((c) => c.name).join(",") }),
    ],
  },
];
