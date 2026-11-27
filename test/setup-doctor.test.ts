import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCK_MARKER, formatDoctor, parseManifest, runDoctor, type Probe, type Profile } from "../scripts/setup-lib.ts";

const manifestPath = fileURLToPath(new URL("../setup/dependencies.json", import.meta.url));
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = parseManifest(manifestText);
const ROOT = "/repo";
const HOME = "/home/u";
const LOCK = '{"lockfileVersion":3}';
const SUB_INTEGRITY = "sha512-Hc7GT36HTU1IsT/MPQbxnqmA90G1tfWJMFrxZ6ISURadGaIx7uad/qzkwL4epgBYRUMB7KOB9r+8k8YhXKP1lw==";

interface Fixture {
  versions?: Record<string, string | null>;
  files?: Record<string, string>;
  hide?: string[];
  nodeVersion?: string;
  env?: Record<string, string>;
  release?: string;
}

function fakeProbe(f: Fixture = {}): Probe {
  const versions: Record<string, string | null> = {
    git: "git version 2.43.0",
    pi: "1.5.2",
    herdr: "herdr 0.9.5",
    treehouse: "v3.1.8",
    gh: "gh version 2.98.0 (2026-08-20)",
    ...f.versions,
  };
  const files: Record<string, string> = {
    [`${ROOT}/package-lock.json`]: LOCK,
    [`${ROOT}/${LOCK_MARKER}`]: `${createHash("sha256").update(LOCK).digest("hex")}\n`,
    [`${ROOT}/bin/pi-factory`]: "",
    [`${ROOT}/bin/pi-orch`]: "",
    [`${ROOT}/src/index.ts`]: "",
    [`${ROOT}/src/worker-ext.ts`]: "",
    [`${HOME}/.pi/agent/skills/implement/SKILL.md`]: "",
    [`${HOME}/.pi/agent/skills/tdd/SKILL.md`]: "",
    [`${ROOT}/src/pr-review/hook.ts`]: "",
    ...f.files,
  };
  const hidden = new Set(f.hide ?? []);
  return {
    root: ROOT,
    home: HOME,
    nodeVersion: f.nodeVersion ?? "22.22.1",
    platform: "linux",
    release: f.release ?? "5.15.0-generic",
    env: f.env ?? {},
    run: (command) => (command in versions ? (versions[command] ?? null) : null),
    read: (p) => (hidden.has(p) ? undefined : files[p]),
    exists: (p) => p in files && !hidden.has(p),
  };
}

const pinnedFiles = (settingsPackages: unknown[]): Record<string, string> => ({
  [`${HOME}/.pi/agent/settings.json`]: JSON.stringify({ packages: settingsPackages }),
  [`${HOME}/.pi/agent/npm/node_modules/pi-subagents/package.json`]: JSON.stringify({ version: "0.88.0" }),
  [`${HOME}/.pi/agent/npm/package-lock.json`]: JSON.stringify({
    packages: { "node_modules/pi-subagents": { integrity: SUB_INTEGRITY } },
  }),
});

const byId = (report: ReturnType<typeof runDoctor>, id: string) => {
  const r = report.results.find((x) => x.id === id);
  assert.ok(r, `sem resultado para ${id}`);
  return r;
};

const complete: Profile = "complete";

test("manifesto real: pi-subagents fixado com integridade e Matt Pocock marcado como não verificado", () => {
  const sub = manifest.dependencies.find((d) => d.id === "pi-subagents");
  assert.ok(sub?.check.type === "pinned-package");
  assert.equal(sub.check.installedVersion, "0.88.0");
  assert.equal(sub.check.integrity, SUB_INTEGRITY);
  const matt = manifest.dependencies.find((d) => d.id === "skills-matt-pocock");
  assert.match(matt?.origin ?? "", /NOT VERIFIED/);
});

test("manifesto: cada dependência tem origem e comando de correção", () => {
  for (const d of manifest.dependencies) {
    assert.ok(d.origin.length > 0, d.id);
    assert.ok(d.fix.length > 0, d.id);
    assert.ok(d.requiredIn.length > 0, d.id);
  }
});

test("manifesto: schema desconhecido é rejeitado", () => {
  assert.throws(() => parseManifest('{"schema":2,"dependencies":[],"optionalEnv":[]}'), /schema/);
});

test("perfil minimal com requisitos básicos: pronto, sem Oracle nem Matt", () => {
  const report = runDoctor(manifest, fakeProbe(), "minimal");
  assert.equal(report.missing, 0);
  assert.equal(byId(report, "pi-subagents").status, "optional", "sem Oracle: opcional, não bloqueia");
  assert.equal(byId(report, "gh").status, "ready", "gh presente aparece como pronto mesmo fora do perfil");
  assert.equal(byId(report, "pi").status, "ready");
});

test("perfil completo sem extras: pi-subagents e skill Matt viram missing com correção", () => {
  const report = runDoctor(manifest, fakeProbe({ hide: [`${HOME}/.pi/agent/skills/tdd/SKILL.md`] }), complete);
  assert.ok(report.missing >= 1);
  assert.equal(byId(report, "pi-subagents").status, "missing");
  assert.match(byId(report, "pi-subagents").fix, /npm:pi-subagents@0.88.0/);
  assert.equal(byId(report, "skills-matt-pocock").status, "missing");
});

test("gh ausente no perfil minimal: optional, não bloqueia; no completo: missing", () => {
  const probe = fakeProbe({ versions: { gh: null } });
  assert.equal(byId(runDoctor(manifest, probe, "minimal"), "gh").status, "optional");
  assert.equal(byId(runDoctor(manifest, probe, complete), "gh").status, "missing");
});

test("pi em versão diferente da fixada: missing com versões no detalhe", () => {
  const report = runDoctor(manifest, fakeProbe({ versions: { pi: "1.6.0" } }), "minimal");
  const pi = byId(report, "pi");
  assert.equal(pi.status, "missing");
  assert.match(pi.detail, /1\.6\.0.*1\.5\.2/);
});

test("herdr abaixo do mínimo: missing; herdr ausente: missing", () => {
  assert.equal(
    byId(runDoctor(manifest, fakeProbe({ versions: { herdr: "herdr 0.8.0" } }), "minimal"), "herdr").status,
    "missing",
  );
  assert.equal(
    byId(runDoctor(manifest, fakeProbe({ versions: { herdr: null } }), "minimal"), "herdr").status,
    "missing",
  );
});

test("node abaixo de 22.18: missing", () => {
  assert.equal(byId(runDoctor(manifest, fakeProbe({ nodeVersion: "22.17.0" }), "minimal"), "node").status, "missing");
});

test("pi-subagents com spec sem versão em settings: missing mesmo com pacote instalado", () => {
  const probe = fakeProbe({ files: pinnedFiles(["npm:pi-subagents"]) });
  const r = byId(runDoctor(manifest, probe, complete), "pi-subagents");
  assert.equal(r.status, "missing");
  assert.match(r.detail, /sem versão fixada/);
});

test("pi-subagents fixado (string e objeto), instalado e com integridade: ready", () => {
  for (const entry of ["npm:pi-subagents@0.88.0", { source: "npm:pi-subagents@0.88.0" }]) {
    const probe = fakeProbe({ files: pinnedFiles([entry]) });
    assert.equal(byId(runDoctor(manifest, probe, complete), "pi-subagents").status, "ready");
  }
});

test("pi-subagents com integridade divergente: missing e detalhe diz diverge", () => {
  const files = pinnedFiles(["npm:pi-subagents@0.88.0"]);
  files[`${HOME}/.pi/agent/npm/package-lock.json`] = JSON.stringify({
    packages: { "node_modules/pi-subagents": { integrity: "sha512-outro" } },
  });
  const r = byId(runDoctor(manifest, fakeProbe({ files }), complete), "pi-subagents");
  assert.equal(r.status, "missing");
  assert.match(r.detail, /diverge/);
});

test("variáveis de ambiente: mostra só se estão definidas, nunca o valor", () => {
  const secret = "sk-SEGREDO-NAO-PODE-APARECER";
  const report = runDoctor(manifest, fakeProbe({ env: { HERDR_ENV: secret } }), "minimal");
  const text = formatDoctor("minimal", report);
  assert.match(text, /env HERDR_ENV: definida/);
  assert.match(text, /env PI_ORCH_NOTIFY: ausente/);
  assert.doesNotMatch(text, /sk-SEGREDO/);
});

test("WSL é reconhecido pelo release do kernel", () => {
  const report = runDoctor(manifest, fakeProbe({ release: "6.18.33.2-microsoft-standard-WSL2" }), "minimal");
  assert.equal(report.platform, "Linux (WSL2)");
});

test("instalação local: marcador alinhado = ready; diferente = missing com comando de correção", () => {
  const ok = byId(runDoctor(manifest, fakeProbe(), "minimal"), "local-install");
  assert.equal(ok.status, "ready");
  const stale = fakeProbe({ files: { [`${ROOT}/${LOCK_MARKER}`]: "outro\n" } });
  const bad = byId(runDoctor(manifest, stale, "minimal"), "local-install");
  assert.equal(bad.status, "missing");
  assert.equal(bad.fix, "npm run bootstrap");
});

test("relatório: linha corrija aparece em tudo que não está pronto", () => {
  const report = runDoctor(manifest, fakeProbe({ versions: { pi: null } }), "minimal");
  const text = formatDoctor("minimal", report);
  assert.match(text, /\[missing\] Pi \(CLI\)/);
  assert.match(text, /corrija: npm install -g @earendil-works\/pi-coding-agent@1\.5\.2/);
  assert.match(text, /resultado: 1 requisito/);
});

test("compatibilidade: sem os launchers bin/pi-factory e bin/pi-orch, o doctor acusa missing", () => {
  const hide = [`${ROOT}/bin/pi-factory`, `${ROOT}/bin/pi-orch`];
  assert.equal(byId(runDoctor(manifest, fakeProbe({ hide }), "minimal"), "launchers").status, "missing");
});
