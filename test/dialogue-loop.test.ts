import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, reopenHarness } from "./fakes.ts";
import { appendAsk } from "../src/shared/ask.ts";

const entry = (id: string, question = "Qual helper usar?", context = "encontrei dois helpers") => ({
  id,
  kind: "operacional",
  question,
  context,
  asked_at: "2026-11-16T12:00:00Z",
});

async function startTask(dialogue_budget?: number) {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "direct-pr",
    ...(dialogue_budget !== undefined ? { dialogue_budget } : {}),
  });
  return { h, t };
}

test("pergunta com evidência nova segue como progresso, sem bloquear", async () => {
  const { h, t } = await startTask();
  appendAsk(t.task_dir, entry("a1", "Qual helper usar?", "contexto A"));
  await h.orch.refresh(t.task_id);
  appendAsk(t.task_dir, entry("a2", "Qual helper usar?", "contexto B"));
  await h.orch.refresh(t.task_id);
  const rec = h.orch.get(t.task_id);
  assert.equal(rec.status, "running");
  assert.equal(rec.pending_ask?.id, "a2");
  assert.equal(rec.pending_ask?.hint ?? null, null, "progresso não traz dica de redirecionamento");
  assert.equal(rec.dialogue?.spent, 2);
});

test("repetição sem evidência nova: primeira vez oferece uma estratégia, segunda bloqueia com resumo", async () => {
  const { h, t } = await startTask();
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  appendAsk(t.task_dir, entry("a2"));
  await h.orch.refresh(t.task_id);
  const redirected = h.orch.get(t.task_id);
  assert.equal(redirected.status, "running", "o redirecionamento não bloqueia");
  assert.match(redirected.pending_ask?.hint ?? "", /UMA estratégia nova/);

  appendAsk(t.task_dir, entry("a3"));
  await h.orch.refresh(t.task_id);
  const stopped = h.orch.get(t.task_id);
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.pending_ask ?? null, null, "a pergunta repetida não fica pendente");
  assert.match(stopped.question ?? "", /sem evidência nova/);
  assert.match(stopped.question ?? "", /Qual helper usar\?/, "a decisão concreta aparece");
  assert.equal(stopped.dialogue?.spent, 2, "a pergunta parada não consome orçamento");
});

test("orçamento esgotado bloqueia com resumo e saldo de perguntas", async () => {
  const { h, t } = await startTask(2);
  appendAsk(t.task_dir, entry("a1", "pergunta um"));
  await h.orch.refresh(t.task_id);
  appendAsk(t.task_dir, entry("a2", "pergunta dois"));
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "running");

  appendAsk(t.task_dir, entry("a3", "pergunta tres"));
  await h.orch.refresh(t.task_id);
  const rec = h.orch.get(t.task_id);
  assert.equal(rec.status, "blocked");
  assert.match(rec.question ?? "", /orçamento de 2 perguntas operacionais esgotado/);
  assert.match(rec.question ?? "", /0 restantes/);
  assert.match(rec.question ?? "", /pergunta tres/);
  assert.equal(rec.dialogue?.budget, 2, "o orçamento configurado na tarefa fica gravado");
});

test("bloqueio do diálogo chega pelo caminho de decisão, sem aviso de pergunta", async () => {
  const { h, t } = await startTask(1);
  appendAsk(t.task_dir, entry("a1", "pergunta um"));
  await h.orch.refresh(t.task_id);
  appendAsk(t.task_dir, entry("a2", "pergunta dois"));
  await h.orch.refresh(t.task_id);
  const ev = await h.orch.noticeFor(t.task_id);
  assert.ok(ev, "o bloqueio gera aviso");
  assert.equal(ev.status, "blocked");
  assert.notEqual(ev.kind, "ask", "não é aviso de pergunta operacional");
});

test("após reinício, o orçamento não é reiniciado nem a pergunta é recontada", async () => {
  const { h, t } = await startTask(2);
  appendAsk(t.task_dir, entry("a1", "pergunta um"));
  await h.orch.refresh(t.task_id);
  appendAsk(t.task_dir, entry("a2", "pergunta dois"));
  await h.orch.refresh(t.task_id);
  const before = h.orch.get(t.task_id).dialogue;

  const restarted = reopenHarness(h);
  await restarted.refresh(t.task_id);
  await restarted.refresh(t.task_id);
  const after = restarted.get(t.task_id);
  assert.equal(after.dialogue?.spent, before?.spent, "a mesma pergunta não é recontada");
  assert.equal(after.status, "running");

  appendAsk(t.task_dir, entry("a3", "pergunta tres"));
  await restarted.refresh(t.task_id);
  assert.equal(restarted.get(t.task_id).status, "blocked", "o orçamento continua esgotado após reinício");
  await restarted.refresh(t.task_id);
  assert.equal(restarted.get(t.task_id).status, "blocked", "bloqueio não entra em loop após reinício");
});

test("reenvio da mesma pergunta (duplicada) não gasta orçamento", async () => {
  const { h, t } = await startTask(3);
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  await h.orch.refresh(t.task_id);
  await h.orch.refresh(t.task_id);
  const rec = h.orch.get(t.task_id);
  assert.equal(rec.dialogue?.spent, 1);
  assert.equal(rec.status, "running");
});

test("bloqueio por orçamento com pergunta anterior sem resposta registra o descarte", async () => {
  const { h, t } = await startTask(1);
  appendAsk(t.task_dir, entry("a1", "pergunta um"));
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).pending_ask?.id, "a1", "a1 fica pendente sem resposta");

  appendAsk(t.task_dir, entry("a2", "pergunta dois"));
  await h.orch.refresh(t.task_id);
  const rec = h.orch.get(t.task_id);
  assert.equal(rec.status, "blocked");
  assert.equal(rec.pending_ask ?? null, null);

  const discarded = h.orch.history(t.task_id, {}).items.find((i) => i.ref === "a1" && i.status === "descartada");
  assert.ok(discarded, "a pergunta pendente descartada aparece na cronologia");
  assert.equal(discarded.kind, "pergunta");
  assert.match(discarded.text, /orçamento/, "o motivo do descarte fica explícito");
  assert.match(rec.question ?? "", /pergunta um/, "o resumo do bloqueio cita a pergunta descartada");
});
