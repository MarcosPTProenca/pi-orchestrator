import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, LOCK_MARKER, type Runner } from "../scripts/setup-lib.ts";

const LOCK = '{"lockfileVersion":3,"packages":{}}';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-factory-boot-"));
  writeFileSync(join(root, "package-lock.json"), LOCK);
  mkdirSync(join(root, ".githooks"));
  return root;
}

interface FakeOpts {
  npmStatus?: number;
  npmWritesPartial?: boolean;
}

function fakeRunner(opts: FakeOpts = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const gitConfig = new Map<string, string>();
  const runner: Runner = {
    run(command, args, cwd) {
      calls.push({ command, args });
      if (command === "npm") {
        if (opts.npmWritesPartial) mkdirSync(join(cwd, "node_modules", "half"), { recursive: true });
        if ((opts.npmStatus ?? 0) === 0) mkdirSync(join(cwd, "node_modules"), { recursive: true });
        return { status: opts.npmStatus ?? 0, stdout: "" };
      }
      if (command === "git" && args[0] === "config" && args[2] === "--get") {
        const v = gitConfig.get(args[3]);
        return { status: v === undefined ? 1 : 0, stdout: v ?? "" };
      }
      if (command === "git" && args[0] === "config" && args[1] === "--local") {
        gitConfig.set(args[2], args[3]);
        return { status: 0, stdout: "" };
      }
      return { status: 127, stdout: "" };
    },
  };
  return { runner, calls, gitConfig };
}

const names = (calls: { command: string; args: string[] }[], command: string) =>
  calls.filter((c) => c.command === command);

test("primeira execução instala e aponta hooks; segunda não duplica nada", () => {
  const root = repo();
  const { runner, calls, gitConfig } = fakeRunner();
  const first = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.deepEqual(
    first.map((s) => s.outcome),
    ["feito", "feito"],
  );
  const second = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.deepEqual(
    second.map((s) => s.outcome),
    ["já estava", "já estava"],
  );
  assert.equal(names(calls, "npm").length, 1, "npm ci roda uma vez");
  assert.equal(
    names(calls, "git").filter((c) => c.args[2] === "core.hooksPath" || c.args[2] === ".githooks").length,
    1,
  );
  assert.equal(gitConfig.get("core.hooksPath"), ".githooks");
});

test("nunca usa escopo global nem toca nada fora do repo", () => {
  const root = repo();
  const home = mkdtempSync(join(tmpdir(), "pi-factory-home-"));
  const before = readdirSync(home).length;
  const { runner, calls } = fakeRunner();
  bootstrap(root, runner, "22.22.1", "22.18.0");
  for (const c of calls) {
    assert.ok(!c.args.some((a) => a === "-g" || a === "--global"), `${c.command} ${c.args.join(" ")}`);
  }
  assert.equal(readdirSync(home).length, before);
  assert.equal(existsSync(join(home, ".pi")), false);
});

test("npm ci que falha: erro sem marcar instalado; a próxima execução refaz", () => {
  const root = repo();
  const failing = fakeRunner({ npmStatus: 1, npmWritesPartial: true });
  assert.throws(() => bootstrap(root, failing.runner, "22.22.1", "22.18.0"), /npm ci falhou.*nada foi marcado/);
  assert.equal(existsSync(join(root, LOCK_MARKER)), false, "instalação interrompida não vira marcador");
  const ok = fakeRunner();
  const steps = bootstrap(root, ok.runner, "22.22.1", "22.18.0");
  assert.equal(steps[0]?.outcome, "feito");
  assert.equal(names(ok.calls, "npm").length, 1);
});

test("falha de rede no npm ci: status e sem vazar saída", () => {
  const root = repo();
  const { runner } = fakeRunner({ npmStatus: 1 });
  try {
    bootstrap(root, runner, "22.22.1", "22.18.0");
    assert.fail("deveria lançar");
  } catch (err) {
    assert.match((err as Error).message, /status 1/);
    assert.doesNotMatch((err as Error).message, /ETIMEDOUT|registry/);
  }
});

test("lock alterado depois da instalação: refaz npm ci", () => {
  const root = repo();
  const { runner, calls } = fakeRunner();
  bootstrap(root, runner, "22.22.1", "22.18.0");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"x":{}}}');
  const steps = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.equal(steps[0]?.outcome, "feito");
  assert.equal(names(calls, "npm").length, 2);
});

test("hooks já apontados por outro valor: corrige para .githooks sem duplicar", () => {
  const root = repo();
  const { runner, gitConfig } = fakeRunner();
  gitConfig.set("core.hooksPath", ".outro");
  const steps = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.equal(steps[1]?.outcome, "feito");
  assert.equal(gitConfig.get("core.hooksPath"), ".githooks");
});

test("Node abaixo do mínimo: recusa antes de qualquer comando", () => {
  const root = repo();
  const { runner, calls } = fakeRunner();
  assert.throws(() => bootstrap(root, runner, "22.17.0", "22.18.0"), /abaixo do mínimo/);
  assert.equal(calls.length, 0);
});

test("marcador gravado é o hash do lock, para o doctor confirmar", () => {
  const root = repo();
  bootstrap(root, fakeRunner().runner, "22.22.1", "22.18.0");
  const marker = readFileSync(join(root, LOCK_MARKER), "utf8").trim();
  assert.match(marker, /^[0-9a-f]{64}$/);
});
