import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../src/contract.ts";
import { acquireOwnership, hasLiveOwner, legacyAdopter, releaseOwnership, scopeKey, scopeOwnerDir } from "../src/lock.ts";
import { Store } from "../src/store.ts";
import { makeHarness } from "./fakes.ts";

const ROOT = process.cwd();

/** Roda uma função de src num processo filho de verdade e devolve o último JSON impresso. */
function child(expr: string): unknown {
  const out = spawnSync(process.execPath, ["--import", "tsx", "-e", expr], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").pop() as string);
}

function gitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-scope-")));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("escopo: subpasta e link do mesmo repo caem no mesmo escopo; repos diferentes não", () => {
  const repo = gitRepo();
  const sub = join(repo, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const link = join(mkdtempSync(join(tmpdir(), "orch-link-")), "repo-link");
  symlinkSync(repo, link);
  const other = gitRepo();
  assert.equal(scopeKey(sub), scopeKey(repo));
  assert.equal(scopeKey(link), scopeKey(repo));
  assert.notEqual(scopeKey(other), scopeKey(repo));
});

test("escopo fora de git usa o próprio diretório", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "orch-plain-")));
  const sibling = realpathSync(mkdtempSync(join(tmpdir(), "orch-plain-")));
  assert.equal(scopeKey(plain), scopeKey(plain));
  assert.notEqual(scopeKey(plain), scopeKey(sibling));
  assert.match(scopeOwnerDir("/s", scopeKey(plain)), /\/s\/owners\/[0-9a-f]{16}$/);
});

test("projetos diferentes têm posse simultânea; o mesmo projeto em outro processo não", () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "orch-own-")));
  const dirA = scopeOwnerDir(state, scopeKey(gitRepo()));
  const dirB = scopeOwnerDir(state, scopeKey(gitRepo()));
  try {
    assert.equal(acquireOwnership(dirA).owner, true);
    assert.equal(acquireOwnership(dirB).owner, true, "projeto B não pode ser bloqueado pelo A");
    const sameAsA = child(`import("./src/lock.ts").then(m=>{console.log(JSON.stringify(m.acquireOwnership(${JSON.stringify(dirA)})));process.exit(0)})`) as { owner: boolean };
    assert.equal(sameAsA.owner, false, "segunda sessão viva do mesmo projeto fica somente leitura");
  } finally {
    releaseOwnership(dirA);
    releaseOwnership(dirB);
  }
  assert.equal(existsSync(join(dirA, "owner.json")), false);
});

test("duas sessões gravando o mesmo estado não perdem atualizações (trava entre processos)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-mutate-"));
  const file = join(dir, "state.json");
  const script = `import("./src/store.ts").then(({Store})=>{const s=new Store(${JSON.stringify(file)});for(let i=0;i<60;i++){s.mutate(st=>{st.workspaces["k"+i+"-"+process.pid]={workspace_id:"w",seeded_tab_id:null};});}console.log("{}");process.exit(0)})`;
  const runs = [0, 1].map(() => spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: ROOT, encoding: "utf8" }));
  for (const r of runs) assert.equal(r.status, 0, r.stderr);
  const total = Object.keys(new Store(file).load().workspaces).length;
  assert.equal(total, 120, "cada escrita sobreviveu: 2 processos x 60");
});

test("trava de escrita abandonada há muito tempo é removida", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-stale-"));
  const file = join(dir, "state.json");
  const lock = `${file}.lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, old, old);
  new Store(file).mutate((st) => {
    st.workspaces["x"] = { workspace_id: "w", seeded_tab_id: null };
  });
  assert.equal(existsSync(lock), false, "trava liberada após a escrita");
  assert.equal(new Store(file).load().workspaces["x"]?.workspace_id, "w");
});

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    task_id: "t-x",
    project_id: "p",
    project_path: "/p",
    role: "r",
    worker_id: "w",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:t1-1",
    terminal_id: "term-1",
    status: "done",
    task_dir: "/nonexistent",
    brief_path: "/nonexistent/brief.md",
    created_at: "2026-11-18T10:00:00.000Z",
    updated_at: "2026-11-18T10:00:00.000Z",
    deadline_at: null,
    question: null,
    result: "ok",
    artifacts: [],
    last_report_key: null,
    notified: false,
    error: null,
    ...over,
  } as TaskRecord;
}

test("orquestrador: cada sessão vê, avisa e altera só as tarefas do próprio escopo", async () => {
  const h = makeHarness();
  const store = new Store(join(h.stateDir, "state.json"));
  store.mutate((s) => {
    s.tasks["t-a"] = task({ task_id: "t-a", owner_key: "A" });
    s.tasks["t-b"] = task({ task_id: "t-b", owner_key: "B" });
    s.tasks["t-legacy"] = task({ task_id: "t-legacy", project_path: "/proj-a" });
  });
  h.orch.setScope("A");
  assert.equal(h.orch.adoptUnowned((p) => p === "/proj-a"), 1, "legado do projeto A é adotado");
  assert.deepEqual(h.orch.owned().map((t) => t.task_id).sort(), ["t-a", "t-legacy"]);
  assert.equal(h.orch.list().length, 3, "list continua mostrando todas");

  const events = await h.orch.sweep();
  assert.deepEqual(events.map((e) => e.task_id).sort(), ["t-a", "t-legacy"], "varredura avisa só o próprio escopo");
  assert.equal(store.load().tasks["t-b"]?.notified, false, "aviso da outra sessão não é consumido");

  await assert.rejects(h.orch.cancel("t-b"), /outra sessão do orquestrador/);
  await assert.rejects(h.orch.close("t-b"), /outra sessão do orquestrador/);
  await assert.rejects(h.orch.send("t-b", "oi"), /outra sessão do orquestrador/);
});

test("sem escopo definido (simulação e testes) todas as tarefas são desta sessão", async () => {
  const h = makeHarness();
  new Store(join(h.stateDir, "state.json")).mutate((s) => {
    s.tasks["t-a"] = task({ task_id: "t-a", owner_key: "A" });
  });
  assert.equal(h.orch.owned().length, 1);
  assert.equal(h.orch.adoptUnowned(() => true), 0, "sem escopo não adota nada");
});

test("sessão da pasta-pai (fora de git) adota legada de repo dentro dela só se o repo não tem sessão viva", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "orch-parent-")));
  const repoFree = join(parent, "free");
  const repoLive = join(parent, "live");
  for (const r of [repoFree, repoLive]) {
    mkdirSync(r);
    execFileSync("git", ["init", "-q", r]);
  }
  const state = realpathSync(mkdtempSync(join(tmpdir(), "orch-state-")));
  const liveDir = scopeOwnerDir(state, scopeKey(repoLive));
  assert.equal(acquireOwnership(liveDir).owner, true);
  try {
    const adopt = legacyAdopter({ key: scopeKey(parent), cwd: parent, stateDir: state });
    assert.equal(adopt(repoFree), true, "repo sem sessão viva dentro do cwd é adotável");
    assert.equal(adopt(repoLive), false, "repo com sessão viva fica com a sessão dele");
    assert.equal(adopt(realpathSync(mkdtempSync(join(tmpdir(), "orch-out-")))), false, "fora do cwd não é adotável");
    assert.equal(adopt(parent + "-irmao"), false, "prefixo parecido não conta como dentro do cwd");

    const h = makeHarness();
    const store = new Store(join(h.stateDir, "state.json"));
    store.mutate((s) => {
      s.tasks["t-free"] = task({ task_id: "t-free", project_path: repoFree });
      s.tasks["t-live"] = task({ task_id: "t-live", project_path: repoLive });
    });
    h.orch.setScope(scopeKey(parent));
    assert.equal(h.orch.adoptUnowned(adopt), 1);
    assert.deepEqual(h.orch.owned().map((t) => t.task_id), ["t-free"]);
  } finally {
    releaseOwnership(liveDir);
  }
});

test("dono de processo morto não bloqueia a adoção; dono vivo bloqueia", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-live-"));
  assert.equal(hasLiveOwner(dir), false, "sem arquivo de posse não há dono vivo");
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: 2 ** 22 - 3, started_at: "x" }));
  assert.equal(hasLiveOwner(dir), false, "pid morto não é dono vivo");
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, started_at: "x" }));
  assert.equal(hasLiveOwner(dir), true, "pid vivo é dono vivo");
});
