import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dirname, "..", "bin");

const stubDir = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-factory-stub-"));
  writeFileSync(join(dir, "pi"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(join(dir, "pi"), 0o755);
  return dir;
})();

function launch(name: string, args: string[], herdr: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, PI_ORCH_NO_SYNC: "1" };
  delete env.HERDR_ENV;
  delete env.HERDR_PANE_ID;
  if (herdr) {
    env.HERDR_ENV = "1";
    env.HERDR_PANE_ID = "p1";
  }
  return spawnSync("bash", [join(bin, name), ...args], { encoding: "utf8", env });
}

test("pi-orch e pi-factory passam os mesmos argumentos ao pi", () => {
  const args = ["--foo", "valor com espaço"];
  const factory = launch("pi-factory", args, true);
  const legacy = launch("pi-orch", args, true);
  assert.equal(factory.status, 0, factory.stderr);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, factory.stdout);
  assert.match(factory.stdout, /src\/index\.ts/);
  assert.equal(factory.stdout.trimEnd().split("\n").at(-1), "valor com espaço");
});

test("fora do Herdr, os dois launchers recusam com a mesma mensagem e status", () => {
  const factory = launch("pi-factory", [], false);
  const legacy = launch("pi-orch", [], false);
  assert.equal(factory.status, 1);
  assert.equal(legacy.status, factory.status);
  assert.equal(legacy.stderr, factory.stderr);
  assert.match(factory.stderr, /pi-factory: rode dentro de um pane do Herdr/);
});

test("pi-orch é só um alias que executa pi-factory", () => {
  const wrapper = readFileSync(join(bin, "pi-orch"), "utf8");
  assert.match(wrapper, /exec bash "\$HERE\/pi-factory" "\$@"/);
  assert.doesNotMatch(wrapper, /pi -e|PI_ORCH_/);
});
