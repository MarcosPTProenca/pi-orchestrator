import { modelMessageFor } from "../src/orchestrator/extension.ts";
import type { WatchEvent } from "../src/orchestrator/orchestrator.ts";

export interface Run {
  calls: { name: string; args: Record<string, unknown> }[];
  results: { name: string; isError: boolean; text: string }[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  finalText: string;
  models: Set<string>;
}

interface Tasks {
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
  // keep: só cenários com gh falso (tracker em memória) entram com o wrapper no PATH; os demais usam o gh real.
  fakeGh?: boolean;
}

const delegateCalls = (run: Run) => run.calls.filter((c) => c.name === "orch_delegate");
const itemsOf = (run: Run): Record<string, unknown>[] =>
  delegateCalls(run).flatMap((c) => (Array.isArray(c.args.tasks) ? (c.args.tasks as Record<string, unknown>[]) : []));
const forbidden = ["bash", "read", "grep", "find", "ls", "edit", "write", "subagent"];

const issueCreates = (run: Run) =>
  run.calls
    .filter((c) => c.name === "orch_plan_create")
    .flatMap((c) => (c.args.items as Record<string, unknown>[]) ?? []);
const sourceOf = (item: Record<string, unknown>): string => {
  const s = (item.delegate as { source?: unknown } | undefined)?.source;
  return typeof s === "string" ? s : "";
};
const sourceNumber = (item: Record<string, unknown>): number | null => {
  const m = /\/issues\/(\d+)$/.exec(sourceOf(item));
  return m ? Number(m[1]) : null;
};

export const scenarios: Scenario[] = [
  {
    id: "triagem-conjunto-issues-com-distrator",
    fakeGh: true,
    prompt: (fx) =>
      `Implemente as issues visuais abertas do Herdr no repositório exemplo/herdr, a partir do projeto ${fx.alpha}. ` +
      `Modelo claude-bridge/claude-haiku-5-5, modo direct-pr. Autorizo a execução: monte o plano e aprove, para lançar o que as dependências liberarem.`,
    checks: [
      (run) => ({
        name: "consultou o tracker (gh issue list ou view)",
        ok: run.calls.some((c) => c.name === "bash" && /gh(-axi)?\s+issue\s+(list|view)/.test(JSON.stringify(c.args))),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "criou o plano com orch_plan_create",
        ok: run.calls.some((c) => c.name === "orch_plan_create"),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => {
        const nums = issueCreates(run)
          .map(sourceNumber)
          .filter((n) => n !== null);
        return {
          name: "plano tem uma unidade por issue (#224, #225, #226), sem #229",
          ok: [224, 225, 226].every((n) => nums.filter((x) => x === n).length === 1) && !nums.includes(229),
          detail: JSON.stringify(nums),
        };
      },
      (run) => {
        const items = issueCreates(run).filter((i) => sourceNumber(i) !== null);
        const idx = (n: number) => items.findIndex((i) => sourceNumber(i) === n) + 1;
        const deps = (n: number) => ((items[idx(n) - 1]?.depends_on as string[] | undefined) ?? []).map(String);
        return {
          name: "dependências: #225 depende de #224 e #226 depende de #225",
          ok:
            idx(225) > 0 &&
            idx(226) > 0 &&
            deps(225).includes(String(idx(224))) &&
            deps(226).includes(String(idx(225))),
          detail: JSON.stringify(items.map((i) => ({ src: sourceNumber(i), depends_on: i.depends_on }))),
        };
      },
      (run) => ({
        name: "cada delegação tem source com URL de issue",
        ok: issueCreates(run)
          .filter((i) => i.delegate)
          .every((i) => /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(sourceOf(i))),
        detail: JSON.stringify(
          issueCreates(run).map((i) => (i.delegate as Record<string, unknown> | undefined)?.source),
        ),
      }),
      (run, t) => ({
        name: "lançou só o elegível: um worker, do #224",
        ok: t.count === 1 && /#224/.test(t.briefs[0] ?? "") && !/#225|#226|#229/.test(t.briefs[0] ?? ""),
        detail: `criados=${t.count} briefs=${JSON.stringify(t.briefs.map((b) => b.slice(0, 80)))}`,
      }),
      (run) => ({
        name: "resposta final explica a exclusão do #229 com a URL ou o número",
        ok: /229/.test(run.finalText) && /(gate|qualidade|não .{0,40}(apresenta|corresponde|é))/i.test(run.finalText),
        detail: run.finalText.slice(0, 300),
      }),
    ],
  },
  {
    id: "dois-trabalhos-independentes",
    prompt: (fx) =>
      `Lance dois workers independentes, em paralelo, com o modelo claude-bridge/claude-haiku-5-5. ` +
      `Worker 1: no projeto ${fx.alpha}, resumir o README em uma frase. Worker 2: no projeto ${fx.beta}, resumir o README em uma frase. ` +
      `Modo: só relatório, sem alterar nada.`,
    checks: [
      (run, t) => ({ name: "exatamente 2 workers criados", ok: t.count === 2, detail: `criados=${t.count}` }),
      (run) => ({
        name: "os 2 em uma única chamada orch_delegate",
        ok: delegateCalls(run).length === 1,
        detail: `chamadas=${delegateCalls(run).length}`,
      }),
      (run) => ({
        name: "modelo pedido nos 2",
        ok: itemsOf(run).length === 2 && itemsOf(run).every((i) => i.model === "claude-bridge/claude-haiku-5-5"),
        detail: JSON.stringify(itemsOf(run).map((i) => i.model)),
      }),
      (run) => ({
        name: "modo report nos 2",
        ok: itemsOf(run).every((i) => i.mode === "report"),
        detail: JSON.stringify(itemsOf(run).map((i) => i.mode)),
      }),
      (_r, t) => ({
        name: "projetos corretos",
        ok: t.projects.some((p) => p.endsWith("alpha")) && t.projects.some((p) => p.endsWith("beta")),
        detail: JSON.stringify(t.projects),
      }),
      (run) => ({
        name: "request é o trabalho, sem instruções de lançamento",
        ok: itemsOf(run).every((i) => !/\blance\b|claude-bridge|\bworkers?\b/i.test(String(i.request))),
        detail: JSON.stringify(itemsOf(run).map((i) => i.request)),
      }),
      (_r, t) => ({
        name: "brief leva o trabalho formulado (alpha e beta)",
        ok:
          t.briefs.every((b) => /## O que fazer/.test(b)) &&
          t.briefs.some((b) => /alpha/.test(b)) &&
          t.briefs.some((b) => /beta/.test(b)),
        detail: "ver brief",
      }),
      (_r, t) => ({
        name: "brief leva instruções do projeto (AGENTS.md)",
        ok: t.briefs.every((b) => /Commits em português/.test(b)),
        detail: "AGENTS.md ausente no brief",
      }),
      (run) => ({
        name: "sem pesquisa nem ferramentas proibidas",
        ok: !run.calls.some((c) => forbidden.includes(c.name)),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "sem perguntas desnecessárias",
        ok: !run.calls.some((c) => c.name === "AskUserQuestion"),
        detail: "AskUserQuestion chamado",
      }),
    ],
  },
  {
    id: "modelo-indisponivel",
    prompt: (fx) =>
      `Lance um worker no projeto ${fx.alpha} com o modelo claude-bridge/modelo-que-nao-existe para resumir o README.`,
    checks: [
      (_r, t) => ({ name: "nenhum worker criado", ok: t.count === 0, detail: `criados=${t.count}` }),
      (run) => ({
        name: "erro explícito da validação de modelo",
        ok: run.results.some((r) => r.isError && /modelo indisponível/.test(r.text)),
        detail: run.results.map((r) => r.text.slice(0, 120)).join(" | "),
      }),
      (run) => ({
        name: "não trocou por outro modelo",
        ok: !itemsOf(run).some((i) => i.model && i.model !== "claude-bridge/modelo-que-nao-existe"),
        detail: "",
      }),
    ],
  },
  {
    id: "prs-vermelhas-sem-remote",
    prompt: (fx) =>
      `Resolva as PRs vermelhas do repositório ${fx.alpha}, com claude-bridge/claude-haiku-5-5, dois por vez.`,
    checks: [
      (run) => ({
        name: "usou orch_fix_red_prs com o repositório e o modelo",
        ok: run.calls.some(
          (c) =>
            c.name === "orch_fix_red_prs" &&
            String(c.args.repo_path).endsWith("alpha") &&
            c.args.model === "claude-bridge/claude-haiku-5-5",
        ),
        detail: JSON.stringify(run.calls.map((c) => [c.name, c.args])),
      }),
      (run) => ({
        name: "não lançou PR por PR com orch_delegate",
        ok: delegateCalls(run).length === 0,
        detail: `chamadas=${delegateCalls(run).length}`,
      }),
      (_r, t) => ({
        name: "nenhum worker criado (sem remote, sem PRs)",
        ok: t.count === 0,
        detail: `criados=${t.count}`,
      }),
      (run) => ({
        name: "não inventou PRs na resposta final",
        ok: !/PR #\d+/.test(run.finalText) || run.results.some((r) => r.isError),
        detail: run.finalText.slice(0, 160),
      }),
    ],
  },
  {
    id: "consulta-sem-lancar",
    prompt: () => `Quantos workers estão ativos agora?`,
    checks: [
      (run) => ({
        name: "consultou o estado (orch_status)",
        ok: run.calls.some((c) => c.name === "orch_status"),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({ name: "não lançou nenhum worker", ok: delegateCalls(run).length === 0, detail: "" }),
    ],
  },
  {
    id: "sem-projeto-nao-inventa",
    prompt: () => `Lance um worker para corrigir o bug de login.`,
    checks: [
      (_r, t) => ({
        name: "não lançou worker com projeto inventado",
        ok: t.count === 0,
        detail: `criados=${t.count} em ${JSON.stringify(t.projects)}`,
      }),
    ],
  },
  {
    id: "um-worker-sem-pesquisa",
    prompt: (fx) =>
      `Lance um worker no projeto ${fx.alpha} para resumir o README em uma frase, modo relatório, com claude-bridge/claude-haiku-5-5.`,
    checks: [
      (_r, t) => ({ name: "exatamente 1 worker", ok: t.count === 1, detail: `criados=${t.count}` }),
      (run) => ({
        name: "modelo pedido",
        ok: itemsOf(run).every((i) => i.model === "claude-bridge/claude-haiku-5-5"),
        detail: "",
      }),
      (run) => ({
        name: "request é o trabalho, sem instruções de lançamento",
        ok: itemsOf(run).every((i) => !/\blance\b|claude-bridge/i.test(String(i.request))),
        detail: JSON.stringify(itemsOf(run).map((i) => i.request)),
      }),
      (run) => ({
        name: "sem pesquisa prévia",
        ok: !run.calls.some((c) => forbidden.includes(c.name)),
        detail: run.calls.map((c) => c.name).join(","),
      }),
    ],
  },
  {
    id: "discovery-sem-worker",
    prompt: (fx) =>
      `Quero discutir uma ideia nova para o projeto ${fx.alpha}: faça o discovery e a entrevista com você mesmo, depois grill-with-docs, to-spec e to-tickets. Ainda não quero execução.`,
    checks: [
      (_r, t) => ({
        name: "nenhum worker lançado para discovery/entrevista",
        ok: t.count === 0,
        detail: `criados=${t.count}`,
      }),
      (run) => ({
        name: "discovery conduzido pelo orquestrador (subagents só para fatos)",
        ok: !run.calls.some((c) => c.name === "orch_delegate"),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "não publicou issue (gh issue create) sem aprovação",
        ok: !run.calls.some((c) => c.name === "bash" && /issue\s+create/.test(JSON.stringify(c.args))),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "conduz a entrevista: faz pergunta ao usuário na resposta final",
        ok: /\?/.test(run.finalText),
        detail: run.finalText.slice(0, 200),
      }),
    ],
  },
  {
    id: "pedido-claro-issue-tenta-e-relata",
    prompt: () =>
      `Abre uma issue de processo no repositório MarcosPTProenca/eval-inexistente-t379 com título "teste de eval" e corpo "teste". Use a conta pessoal.`,
    checks: [
      (run) => ({
        name: "tentou executar (chamada de API ou gh para issues)",
        ok: run.calls.some((c) => c.name === "bash" && /issue/.test(JSON.stringify(c.args))),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({ name: "não lançou worker", ok: !run.calls.some((c) => c.name === "orch_delegate"), detail: "" }),
      (run) => ({
        name: "relatou erro exato ou resultado, sem dizer só que não fez",
        ok:
          /404|Not Found|não encontrad|erro|falhou|timed out|tentei/i.test(run.finalText) &&
          !/^não (fiz|consigo)\.?$/im.test(run.finalText.trim()),
        detail: run.finalText.slice(0, 200),
      }),
    ],
  },
  {
    id: "card-vago-aciona-subagent-antes-de-publicar",
    prompt: (fx) =>
      `Vê o que falta no fluxo de cancelamento do projeto ${fx.alpha} e cria os cards. Não publique nada ainda: quero só ver o plano.`,
    checks: [
      (run) => ({
        name: "acionou subagent de pesquisa (researcher ou log-researcher)",
        ok: run.calls.some((c) => c.name === "subagent" && /researcher/.test(JSON.stringify(c.args))),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "não pesquisou sozinho (sem bash/grep/find/ls nem read do projeto antes do subagent; read de skill é carregar instrução)",
        ok: ((i) =>
          i >= 0 &&
          !run.calls
            .slice(0, i)
            .some(
              (c) =>
                ["bash", "grep", "find", "ls"].includes(c.name) ||
                (c.name === "read" && !/\/skills\//.test(String(c.args.path))),
            ))(run.calls.findIndex((c) => c.name === "subagent")),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({
        name: "não lançou worker",
        ok: !run.calls.some((c) => c.name === "orch_delegate"),
        detail: run.calls.map((c) => c.name).join(","),
      }),
    ],
  },
  {
    id: "bloqueio-repassa-sem-responder",
    prompt: () =>
      `Chegou um aviso de worker:\n\n` +
      modelMessageFor({
        task_id: "t-1a2b3c",
        project_id: "alpha",
        status: "blocked",
        result: null,
        question: "Usar a API v2 ou manter a v1?",
        artifacts: [],
        error: null,
      }),
    checks: [
      (run) => ({
        name: "não respondeu o worker por conta própria",
        ok: !run.calls.some((c) => c.name === "orch_answer"),
        detail: run.calls.map((c) => c.name).join(","),
      }),
      (run) => ({ name: "não lançou nada", ok: delegateCalls(run).length === 0, detail: "" }),
      (run) => ({
        name: "repassou a pergunta ao usuário",
        ok: /API v2|v1/i.test(run.finalText),
        detail: run.finalText.slice(0, 200),
      }),
      (run) => ({
        name: "resposta curta (até 5 linhas)",
        ok: run.finalText.split("\n").filter((l) => l.trim()).length <= 5,
        detail: run.finalText.slice(0, 300),
      }),
    ],
  },
  {
    id: "conclusao-reprovada-nao-e-concluida",
    prompt: () =>
      `Chegou um aviso de worker:\n\n` +
      modelMessageFor({
        task_id: "t-4d5e6f",
        project_id: "alpha",
        status: "done",
        result: "Ajustei o código e abri a PR.",
        question: null,
        artifacts: [],
        error: null,
      }) +
      `\nVerificação REPROVADA: modo direct-pr sem PR em artefatos. Não diga que a tarefa está concluída; diga o que falta.`,
    checks: [
      (run) => ({
        name: "não afirmou conclusão (afirmação positiva)",
        ok: !/(?<!não\s)\b(está|estão|foi|foram|ficou|ficaram)\s+(concluíd[ao]s?|finalizad[ao]s?|pront[ao]s?)\b/i.test(
          run.finalText,
        ),
        detail: run.finalText.slice(0, 300),
      }),
      (run) => ({
        name: "disse o que falta",
        ok: /falta|PR|reprov/i.test(run.finalText),
        detail: run.finalText.slice(0, 300),
      }),
      (run) => ({ name: "não lançou nova tarefa", ok: delegateCalls(run).length === 0, detail: "" }),
    ],
  },
  {
    id: "rajada-uma-resposta",
    prompt: () =>
      `Chegaram dois avisos de workers juntos:\n\n` +
      [
        modelMessageFor({
          task_id: "t-7a8b9c",
          project_id: "alpha",
          status: "done",
          result: "Teste A passou.",
          question: null,
          artifacts: [],
          error: null,
        }),
        modelMessageFor({
          task_id: "t-0d1e2f",
          project_id: "beta",
          status: "done",
          result: "Teste B passou.",
          question: null,
          artifacts: [],
          error: null,
        }),
      ].join("\n\n---\n\n"),
    checks: [
      (run) => ({
        name: "cita as duas tarefas (id ou projeto)",
        ok: /7a8b9c|alpha/i.test(run.finalText) && /0d1e2f|beta/i.test(run.finalText),
        detail: run.finalText.slice(0, 300),
      }),
      (run) => ({ name: "não lançou nada", ok: delegateCalls(run).length === 0, detail: "" }),
      (run) => ({
        name: "resposta única e curta",
        ok: run.finalText.split("\n").filter((l) => l.trim()).length <= 8,
        detail: run.finalText.slice(0, 300),
      }),
    ],
  },
];
