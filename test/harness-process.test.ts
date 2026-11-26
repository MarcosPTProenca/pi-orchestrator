import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessGroup } from "../scripts/harness-process.ts";

// Processo vivo = existe e não é zumbi (zumbi já morreu, só falta ser colhido).
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/\) Z /.test(stat);
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "harness-pg-"));
}

const env = process.env;

test("comando que sai com 0 retorna code 0 sem timeout", async () => {
  const dir = tmp();
  try {
    const r = await runProcessGroup("sh", ["-c", "echo ok"], { cwd: dir, env, timeout: 10_000 });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("código de saída diferente de zero é repassado", async () => {
  const dir = tmp();
  try {
    const r = await runProcessGroup("sh", ["-c", "echo erro 1>&2; exit 3"], { cwd: dir, env, timeout: 10_000 });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /erro/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no prazo, mata o neto que ficaria órfão", async () => {
  const dir = tmp();
  const pidFile = join(dir, "neto.pid");
  try {
    // sh espera um neto (sleep) que herda o grupo; sem matar o grupo, o neto sobrevive.
    const r = await runProcessGroup("sh", ["-c", `sleep 300 & echo $! > ${pidFile}; wait`], {
      cwd: dir,
      env,
      timeout: 1500,
    });
    assert.equal(r.timedOut, true);
    assert.ok(existsSync(pidFile), "neto registrou o pid");
    const netoPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(await waitDead(netoPid, 3000), `neto ${netoPid} deve morrer com o grupo`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ao sair normalmente, também limpa neto que sobrou", async () => {
  const dir = tmp();
  const pidFile = join(dir, "neto.pid");
  try {
    const r = await runProcessGroup("sh", ["-c", `sleep 300 & echo $! > ${pidFile}; exit 0`], {
      cwd: dir,
      env,
      timeout: 10_000,
    });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
    const netoPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(await waitDead(netoPid, 3000), `neto ${netoPid} deve morrer ao fechar`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
