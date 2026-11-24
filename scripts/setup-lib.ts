import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";

export type Profile = "minimal" | "complete";
type Status = "ready" | "missing" | "optional";

type Check =
  | { type: "node"; minVersion: string }
  | { type: "binary"; command: string; args: string[]; minVersion?: string; exactVersion?: string }
  | { type: "pinned-package"; spec: string; installedVersion: string; integrity: string; packageDir: string }
  | { type: "file"; path: string }
  | { type: "files"; paths: string[] }
  | { type: "local-install" };

interface Dependency {
  id: string;
  label: string;
  check: Check;
  requiredIn: Profile[];
  origin: string;
  fix: string;
}

export interface Manifest {
  schema: number;
  dependencies: Dependency[];
  optionalEnv: { name: string; why: string }[];
}

export interface Probe {
  root: string;
  home: string;
  nodeVersion: string;
  platform: string;
  release: string;
  env: Record<string, string | undefined>;
  run(command: string, args: string[]): string | null;
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

export interface Result {
  id: string;
  label: string;
  status: Status;
  detail: string;
  fix: string;
}

export const LOCK_MARKER = "node_modules/.pi-factory-lock.sha256";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (m.schema !== 1) throw new Error(`schema de manifesto desconhecido: ${String(m.schema)}`);
  for (const d of m.dependencies) {
    if (!d.id || !d.origin || !d.fix || d.requiredIn.length === 0) throw new Error(`entrada incompleta: ${d.id}`);
  }
  return m;
}

const versionOf = (text: string): string | undefined => text.match(/\d+\.\d+\.\d+/)?.[0];

const resolvePath = (probe: Probe, rel: string): string =>
  rel.startsWith(".pi/agent/") ? join(probe.home, rel) : join(probe.root, rel);

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

function parseJson(text: string | undefined): Record<string, unknown> {
  try {
    return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return {};
  }
}

function checkBinary(c: Extract<Check, { type: "binary" }>, probe: Probe): { ok: boolean; detail: string } {
  const out = probe.run(c.command, c.args);
  if (out === null) return { ok: false, detail: "não executa (ausente no PATH ou erro)" };
  const v = versionOf(out);
  if (c.exactVersion !== undefined)
    return { ok: v === c.exactVersion, detail: `versão ${v ?? "desconhecida"}, esperada ${c.exactVersion}` };
  if (c.minVersion !== undefined) {
    const ok = v !== undefined && compareVersions(v, c.minVersion) >= 0;
    return { ok, detail: `versão ${v ?? "desconhecida"}, mínimo ${c.minVersion}` };
  }
  return { ok: true, detail: v ? `presente (versão ${v})` : "presente" };
}

function checkPinnedPackage(
  c: Extract<Check, { type: "pinned-package" }>,
  probe: Probe,
): { ok: boolean; detail: string } {
  const settings = parseJson(probe.read(join(probe.home, ".pi/agent/settings.json")));
  const packages = Array.isArray(settings.packages) ? (settings.packages as unknown[]) : [];
  const specInSettings = packages.some(
    (p) => (typeof p === "string" ? p : (p as { source?: string }).source) === c.spec,
  );
  const installed = parseJson(probe.read(join(probe.home, c.packageDir, "package.json"))).version;
  const lock = parseJson(probe.read(join(probe.home, ".pi/agent/npm/package-lock.json")));
  const lockEntry = (lock.packages as Record<string, { integrity?: string }> | undefined)?.[
    "node_modules/pi-subagents"
  ];
  const integrityOk = lockEntry?.integrity === c.integrity;
  const versionOk = installed === c.installedVersion;
  const ok = specInSettings && versionOk && integrityOk;
  const detail = [
    `spec ${specInSettings ? "fixada" : "sem versão fixada em settings"}`,
    `instalado ${typeof installed === "string" ? installed : "ausente"}`,
    `integridade ${integrityOk ? "confere" : "diverge ou ausente"}`,
  ].join("; ");
  return { ok, detail };
}

function checkLocalInstall(probe: Probe): { ok: boolean; detail: string } {
  const lock = probe.read(join(probe.root, "package-lock.json"));
  const marker = probe.read(join(probe.root, LOCK_MARKER))?.trim();
  const ok = lock !== undefined && marker === hashOf(lock);
  return {
    ok,
    detail: ok ? "node_modules alinhado ao package-lock.json" : "node_modules ausente ou diferente do lock",
  };
}

function evaluate(dep: Dependency, probe: Probe): { ok: boolean; detail: string } {
  const c = dep.check;
  switch (c.type) {
    case "node": {
      const ok = compareVersions(probe.nodeVersion, c.minVersion) >= 0;
      return { ok, detail: `node ${probe.nodeVersion}, mínimo ${c.minVersion}` };
    }
    case "binary":
      return checkBinary(c, probe);
    case "pinned-package":
      return checkPinnedPackage(c, probe);
    case "file": {
      const ok = probe.exists(resolvePath(probe, c.path));
      return { ok, detail: `${c.path} ${ok ? "encontrado" : "ausente"}` };
    }
    case "files": {
      const present = c.paths.filter((p) => probe.exists(resolvePath(probe, p))).length;
      return { ok: present === c.paths.length, detail: `${present}/${c.paths.length} presentes` };
    }
    case "local-install":
      return checkLocalInstall(probe);
  }
}

export function runDoctor(
  manifest: Manifest,
  probe: Probe,
  profile: Profile,
): { results: Result[]; env: Result[]; missing: number; platform: string } {
  const results = manifest.dependencies.map((dep): Result => {
    const { ok, detail } = evaluate(dep, probe);
    const required = dep.requiredIn.includes(profile);
    const status: Status = ok ? "ready" : required ? "missing" : "optional";
    return { id: dep.id, label: dep.label, status, detail, fix: dep.fix };
  });
  const env = manifest.optionalEnv.map((e): Result => {
    const set = (probe.env[e.name] ?? "") !== "";
    return {
      id: e.name,
      label: `env ${e.name}`,
      status: "optional",
      detail: set ? "definida" : `ausente (${e.why})`,
      fix: "",
    };
  });
  const wsl = probe.release.toLowerCase().includes("microsoft");
  const platform =
    probe.platform === "linux" ? (wsl ? "Linux (WSL2)" : "Linux") : `${probe.platform} (não validado para a Factory)`;
  return { results, env, missing: results.filter((r) => r.status === "missing").length, platform };
}

export function formatDoctor(profile: Profile, report: ReturnType<typeof runDoctor>): string {
  const lines = [`pi-factory doctor (perfil ${profile}) — plataforma: ${report.platform}`];
  for (const r of [...report.results, ...report.env]) {
    lines.push(`[${r.status}] ${r.label}: ${r.detail}`);
    if (r.status !== "ready" && r.fix !== "") lines.push(`    corrija: ${r.fix}`);
  }
  lines.push(
    report.missing === 0 ? "resultado: pronto para o perfil" : `resultado: ${report.missing} requisito(s) faltando`,
  );
  return lines.join("\n");
}

export interface Runner {
  run(command: string, args: string[], cwd: string): { status: number; stdout: string };
}

export interface Step {
  name: string;
  outcome: "feito" | "já estava";
}

export function bootstrap(root: string, runner: Runner, nodeVersion: string, minNode: string): Step[] {
  if (compareVersions(nodeVersion, minNode) < 0) throw new Error(`Node ${nodeVersion} abaixo do mínimo ${minNode}`);
  const steps: Step[] = [];
  const lock = readFileSync(join(root, "package-lock.json"), "utf8");
  const markerPath = join(root, LOCK_MARKER);
  if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === hashOf(lock)) {
    steps.push({ name: "dependências", outcome: "já estava" });
  } else {
    const r = runner.run("npm", ["ci", "--no-audit", "--no-fund"], root);
    if (r.status !== 0)
      throw new Error(`npm ci falhou (status ${r.status}); nada foi marcado como instalado, rode de novo`);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(markerPath, `${hashOf(lock)}\n`);
    steps.push({ name: "dependências", outcome: "feito" });
  }
  if (existsSync(join(root, ".githooks"))) {
    const current = runner.run("git", ["config", "--local", "--get", "core.hooksPath"], root).stdout.trim();
    if (current === ".githooks") {
      steps.push({ name: "hooks do git (escopo local)", outcome: "já estava" });
    } else {
      const r = runner.run("git", ["config", "--local", "core.hooksPath", ".githooks"], root);
      if (r.status !== 0) throw new Error("git config --local falhou ao apontar core.hooksPath");
      steps.push({ name: "hooks do git (escopo local)", outcome: "feito" });
    }
  }
  return steps;
}

export const realRunner: Runner = {
  run(command, args, cwd) {
    const r = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  },
};

export function realProbe(root: string): Probe {
  return {
    root,
    home: homedir(),
    nodeVersion: process.versions.node,
    platform: process.platform,
    release: release(),
    env: process.env,
    run(command, args) {
      const r = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
      if (r.error || r.status !== 0) return null;
      return `${r.stdout}\n${r.stderr}`;
    },
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    exists: existsSync,
  };
}
