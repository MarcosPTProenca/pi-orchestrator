import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest } from "./fakes.ts";
import orchestratorExtension from "../src/orchestrator/extension.ts";
import { PlanStore } from "../src/orchestrator/plans.ts";

const MODEL = "claude-bridge/claude-haiku-5-5";
const REPO = "https://github.com/exemplo/herdr";

const tracker = new Map<number, { title: string; state: "open" | "closed" }>([
  [224, { title: "Visual do painel de tarefas", state: "open" }],
  [225, { title: "Visual do status por worker", state: "open" }],
  [226, { title: "Visual do histórico de planos", state: "open" }],
  [229, { title: "Gate de qualidade de UI (não é apresentação do Herdr)", state: "open" }],
]);

const sourceOf = (n: number): string => `${REPO}/issues/${n}`;

function issueOf(url: string): { number: number; state: string } | undefined {
  const m = /\/issues\/(\d+)$/.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  const issue = tracker.get(n);
  return issue ? { number: n, state: issue.state } : undefined;
}

function delegateFor(n: number, source: string | undefined = sourceOf(n)) {
  return {
    project_path: "",
    mode: "direct-pr",
    model: MODEL,
    request: `Implemente a issue #${n}.`,
    objective: `Critérios da issue #${n} atendidos.`,
    acceptance: [`Critérios da issue #${n} atendidos com testes verdes`],
    ...(source === undefined ? {} : { source }),
  };
}

type Exec = (id: string, raw: Record<string, unknown>) => unknown;

function fakePi() {
  const tools = new Map<string, { execute: Exec }>();
  const registry: Record<string, unknown> = {
    registerTool(t: { name: string; execute: Exec }) {
      tools.set(t.name, t);
    },
  };
  const pi = new Proxy(registry, {
    get(target, prop: string) {
      return prop in target ? target[prop] : () => undefined;
    },
  });
  return {
    pi: pi as unknown as ExtensionAPI,
    // keep: a chamada vira Promise mesmo quando a ferramenta lança síncrono, como o Pi faz com o await
    call: (name: string, raw: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolve) => {
        const t = tools.get(name);
        if (!t) throw new Error(`ferramenta ausente: ${name}`);
        resolve(t.execute("integracao", raw));
      }),
  };
}

// keep: fakes de pi --list-models e quota-axi; sem eles o resultado depende da configuração de quem roda (ex.: CI sem provedores).
function fakeCliBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "triagem-bin-"));
  const pi = [
    "#!/bin/sh",
    'if [ "$1" = "--list-models" ]; then',
    "  printf 'provider model context\\nclaude-bridge claude-haiku-5-5 200K\\nopenai-codex gpt-6-luna 272K\\n'",
    "  exit 0",
    "fi",
    'echo "fake pi: comando não simulado: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const quota = [
    "#!/bin/sh",
    'printf \'%s\\n\' \'{"providers":[{"provider":"claude","quotaSemantics":{"effectiveAvailability":[{"scope":"all_models","effectivePercentRemaining":90}]},"state":{"stale":false}},{"provider":"codex","quotaSemantics":{"effectiveAvailability":[{"scope":"all_models","effectivePercentRemaining":90}]},"state":{"stale":false}}]}\'',
    "",
  ].join("\n");
  for (const [name, body] of [
    ["pi", pi],
    ["quota-axi", quota],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "triagem-state-"));
  const project = mkdtempSync(join(tmpdir(), "triagem-proj-"));
  mkdirSync(join(project, ".git"));
  writeManifest(project);
  const saved = { dry: process.env.PI_ORCH_DRY_RUN, dir: process.env.PI_ORCH_STATE_DIR, path: process.env.PATH };
  process.env.PI_ORCH_DRY_RUN = "1";
  process.env.PI_ORCH_STATE_DIR = stateDir;
  process.env.PATH = `${fakeCliBin()}:${saved.path ?? ""}`;
  const restore = () => {
    if (saved.dry === undefined) delete process.env.PI_ORCH_DRY_RUN;
    else process.env.PI_ORCH_DRY_RUN = saved.dry;
    if (saved.dir === undefined) delete process.env.PI_ORCH_STATE_DIR;
    else process.env.PI_ORCH_STATE_DIR = saved.dir;
    process.env.PATH = saved.path ?? "";
  };
  const f = fakePi();
  orchestratorExtension(f.pi);
  const tasks = () => {
    const file = join(stateDir, "state.json");
    if (!existsSync(file)) return [] as { task_id: string; brief_path: string }[];
    const state = JSON.parse(readFileSync(file, "utf8")) as {
      tasks: Record<string, { task_id: string; brief_path: string }>;
    };
    return Object.values(state.tasks);
  };
  return { stateDir, project, f, tasks, restore };
}

function plannedItems(n: number[], project: string) {
  return n.map((num, i) => ({
    title: `#${num}`,
    ...(i === 0 ? {} : { depends_on: [`${i}`] }),
    delegate: { ...delegateFor(num), project_path: project },
  }));
}

test("#239 integração: plano sem delegate.source de issue é recusado antes de gravar", async () => {
  const h = setup();
  try {
    const items = plannedItems([224], h.project);
    (items[0].delegate as { source?: string }).source = undefined;
    await assert.rejects(h.f.call("orch_plan_create", { id: "sem-origem", title: "Sem origem", items }), /source/);
    assert.equal(existsSync(join(h.stateDir, "plans", "sem-origem.json")), false, "nada é gravado");
  } finally {
    h.restore();
  }
});

test("#239 integração: seleção → plano com uma unidade por issue → delegação só do elegível", async () => {
  const h = setup();
  try {
    const items = plannedItems([224, 225, 226], h.project);

    for (const it of items) {
      const src = it.delegate.source ?? "";
      const issue = issueOf(src);
      assert.ok(issue, `source sem issue no tracker: ${src}`);
      assert.equal(issue.state, "open");
      assert.notEqual(issue.number, 229);
    }

    await h.f.call("orch_plan_create", { id: "visuais-herdr", title: "Visuais do Herdr", items });
    const store = new PlanStore(join(h.stateDir, "plans"));
    assert.deepEqual(
      store.show("visuais-herdr").items.map((i) => i.delegate?.source),
      [sourceOf(224), sourceOf(225), sourceOf(226)],
      "uma unidade por issue, na ordem das dependências",
    );

    await h.f.call("orch_plan_approve", { id: "visuais-herdr" });
    assert.equal(h.tasks().length, 1, "só o item sem dependência é lançado");
    const first = readFileSync(h.tasks()[0].brief_path, "utf8");
    assert.match(first, /#224/);
    assert.doesNotMatch(first, /#225|#226|#229/, "o brief leva só a sua issue");

    const taskId = h.tasks()[0].task_id;
    store.markMerged(taskId);
    await h.f.call("orch_plan_pause", { id: "visuais-herdr" });
    await h.f.call("orch_plan_approve", { id: "visuais-herdr" });
    assert.equal(h.tasks().length, 2, "#225 é lançada após o merge de #224");
    const second = h.tasks().find((t) => t.task_id !== taskId);
    assert.ok(second);
    const body = readFileSync(second.brief_path, "utf8");
    assert.match(body, /#225/);
    assert.doesNotMatch(body, /#226|#229/);
    assert.ok(
      readdirSync(join(h.stateDir, "plans")).some((f) => f === "visuais-herdr.json"),
      "plano persistido",
    );
  } finally {
    h.restore();
  }
});
