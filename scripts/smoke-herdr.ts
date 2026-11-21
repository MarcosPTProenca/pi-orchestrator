import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { HerdrCli } from "../src/herdr.ts";
import { Orchestrator, type WatchEvent } from "../src/orchestrator.ts";
import { Store } from "../src/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workerExt = join(here, "..", "src", "worker-ext.ts");

if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
  console.error("smoke: rode dentro de um pane do Herdr");
  process.exit(1);
}

const stateDir = mkdtempSync(join(tmpdir(), "pi-orch-smoke-state-"));
const project = mkdtempSync(join(tmpdir(), "pi-orch-smoke-proj-"));
writeFileSync(join(project, "README.md"), "Projeto descartável do smoke test do pi-orchestrator.\n");
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["add", "README.md"], { cwd: project });
execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "chore: inicia projeto descartável do smoke"], { cwd: project });

const orch = new Orchestrator({
  herdr: new HerdrCli(),
  store: new Store(join(stateDir, "state.json")),
  tasksDir: join(stateDir, "tasks"),
  workerExtPath: workerExt,
  now: () => Date.now(),
  newHex: () => randomBytes(4).toString("hex"),
  availableModels: () => [],
  dryRun: false,
});

const log = (msg: string) => console.log(`[smoke ${new Date().toISOString()}] ${msg}`);

async function watchUntilSettled(taskId: string, label: string): Promise<WatchEvent> {
  let ev: WatchEvent | null = null;
  for (let i = 0; i < 240 && !ev; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    ev = await orch.refresh(taskId);
  }
  if (!ev) throw new Error(`${label}: sem evento após 20 min`);
  log(`${label}: evento=${ev.status} result=${JSON.stringify(ev.result)} question=${JSON.stringify(ev.question)} error=${JSON.stringify(ev.error)}`);
  return ev;
}

async function scenarioDone(): Promise<void> {
  log("A: conclusão");
  const t = await orch.delegate({
    project_path: project,
    role: "smoke-report",
    request:
      "Leia o arquivo README.md no diretório atual. Não edite nenhum arquivo. " +
      "Ao terminar, chame orch_report com status done e, em result, a primeira linha do README.",
    objective: "Concluir o pedido e reportar.",
    mode: "report",
    timeout_minutes: 8,
  });
  log(`A: delegada task=${t.task_id} pane=${t.pane_id} worker=${t.worker_id}`);
  const ev = await watchUntilSettled(t.task_id, "A");
  if (ev.status !== "done") throw new Error(`A: esperado done, veio ${ev.status}`);
  const panesA = (await new HerdrCli().panes()).map((p) => p.pane_id);
  if (!panesA.includes(t.pane_id)) throw new Error("A: tab de tarefa concluída deveria continuar aberta até a validação");
  if (!orch.takeNotice(t.task_id)) throw new Error("A: aviso deveria estar pendente uma vez");
  if (orch.takeNotice(t.task_id)) throw new Error("A: aviso repetido");
  const outcome = await orch.closeOutcome(t.task_id);
  if (!outcome.closed) throw new Error(`A: orch_close deveria fechar a tab (${outcome.reason ?? "sem motivo"})`);
  const panesA2 = (await new HerdrCli().panes()).map((p) => p.pane_id);
  if (panesA2.includes(t.pane_id)) throw new Error("A: tab continua aberta após orch_close");
  log("A: OK (done, aviso deduplicado, orch_close fechou a tab)");
}

async function scenarioBlockedAnswer(): Promise<void> {
  log("B: bloqueio e resposta");
  const t = await orch.delegate({
    project_path: project,
    role: "smoke-question",
    request:
      "Antes de qualquer coisa, chame orch_report com status blocked e a pergunta exata: " +
      "'Responder em português ou inglês?'. Encerre o turno. " +
      "Quando receber a resposta na próxima mensagem, chame orch_report com status done, " +
      "em result escreva apenas a resposta recebida.",
    objective: "Concluir o pedido e reportar.",
    mode: "report",
    timeout_minutes: 8,
  });
  const ev = await watchUntilSettled(t.task_id, "B1");
  if (ev.status !== "blocked") throw new Error(`B: esperado blocked, veio ${ev.status}`);
  const pending = await orch.inbox();
  if (!pending.some((p) => p.task_id === t.task_id && p.status === "blocked")) throw new Error("B: decisão não apareceu no inbox");
  await orch.answer(t.task_id, "Português.");
  log("B: resposta enviada");
  const done = await watchUntilSettled(t.task_id, "B2");
  if (done.status !== "done") throw new Error(`B: esperado done após resposta, veio ${done.status}`);
  log("B: OK (blocked, inbox, resposta, done)");
}

async function scenarioCancel(): Promise<void> {
  log("C: cancelamento");
  const t = await orch.delegate({
    project_path: project,
    role: "smoke-cancel",
    request: "Escreva um poema de 20 linhas sobre pipes e depois chame orch_report com status done.", objective: "Escreva um poema de 20 linhas sobre pipes e depois chame orch_report com status done.", mode: "report",
    timeout_minutes: 8,
  });
  log(`C: delegada task=${t.task_id} workspace=${t.workspace_id} tab=${t.tab_id} pane=${t.pane_id}`);
  await new Promise((r) => setTimeout(r, 5_000));
  const c = await orch.cancel(t.task_id);
  const after = (await new HerdrCli().panes()).map((p) => p.pane_id);
  if (c.status !== "cancelled") throw new Error(`C: status ${c.status}`);
  if (after.includes(t.pane_id)) throw new Error("C: pane da tarefa não foi fechado");
  if (!after.includes(process.env.HERDR_PANE_ID as string)) throw new Error("C: pane do orquestrador foi afetado");
  log(`C: OK (tab da tarefa fechada; pane do orquestrador preservado; panes depois=${after.join(",")})`);
}

async function cleanup(): Promise<void> {
  for (const t of orch.list()) {
    if (t.status === "starting" || t.status === "running" || t.status === "blocked") {
      await orch.cancel(t.task_id).then(() => log(`limpeza: ${t.task_id} cancelada`), (e) => log(`limpeza falhou: ${String(e)}`));
    }
  }
}

function closeSmokeWorkspaces(): void {
  for (const ws of Object.values(new Store(join(stateDir, "state.json")).load().workspaces)) {
    try {
      execFileSync("herdr", ["workspace", "close", ws.workspace_id], { stdio: "ignore", timeout: 20_000 });
      log(`limpeza: workspace ${ws.workspace_id} fechado`);
    } catch (e) {
      log(`limpeza: workspace ${ws.workspace_id} não fechado: ${String(e)}`);
    }
  }
}

async function scenarioConcurrent(): Promise<void> {
  log("D: duas tarefas simultâneas no mesmo projeto");
  const briefs = ["Leia README.md e chame orch_report com status done e a primeira palavra do arquivo em result.", "Liste os arquivos do diretório atual e chame orch_report com status done e a quantidade de itens em result."];
  const tasks = [];
  for (const [i, brief] of briefs.entries()) {
    tasks.push(await orch.delegate({ project_path: project, role: `smoke-par-${i}`, request: brief, objective: brief, mode: "report", timeout_minutes: 8 }));
  }
  if (tasks[0].workspace_id !== tasks[1].workspace_id) throw new Error("D: as duas deveriam estar no mesmo workspace do projeto");
  if (tasks[0].tab_id === tasks[1].tab_id) throw new Error("D: cada tarefa deveria ter sua tab");
  log(`D: workspace=${tasks[0].workspace_id} tabs=${tasks[0].tab_id},${tasks[1].tab_id}`);
  const events = await Promise.all(tasks.map((t, i) => watchUntilSettled(t.task_id, `D${i}`)));
  for (const ev of events) if (ev.status !== "done") throw new Error(`D: esperado done, veio ${ev.status}`);
  log("D: OK (duas tarefas concluídas em paralelo)");
}

async function main(): Promise<void> {
  log(`estado isolado: ${stateDir}; projeto descartável: ${project}`);
  try {
    await scenarioDone();
    await scenarioBlockedAnswer();
    await scenarioCancel();
    await scenarioConcurrent();
    log("SMOKE OK");
  } finally {
    await cleanup();
    closeSmokeWorkspaces();
  }
}

main().catch((err: unknown) => {
  log(`SMOKE FALHOU: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
