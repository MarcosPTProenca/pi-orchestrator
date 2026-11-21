import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, countCommentLines, deadCodeCount, typeErrorCount } from "./quality-lib.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const dir = join(root, "quality");
const update = process.argv.includes("--update");
const readJson = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

function duplication() {
  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  spawnSync("npx", ["jscpd", "src", "test", "scripts", "--silent", "--reporters", "json", "--output", out], { cwd: root, encoding: "utf8" });
  const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
  return Math.round(report.statistics.total.percentage * 100) / 100;
}

function deadCode() {
  const r = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], { cwd: root, encoding: "utf8" });
  return deadCodeCount(JSON.parse(r.stdout));
}

function commentLines() {
  const files = execFileSync("git", ["ls-files", "src", "test", "scripts", "evals"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|mjs)$/.test(f));
  return files.reduce((sum, f) => sum + countCommentLines(readFileSync(join(root, f), "utf8"), f).lines, 0);
}

function typeErrors() {
  const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
  return typeErrorCount(`${r.stdout}\n${r.stderr}`);
}

const current = {
  duplication_pct: duplication(),
  dead_code: deadCode(),
  comment_lines: commentLines(),
  type_errors: typeErrors(),
};

if (update) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), `${JSON.stringify(current, null, 2)}\n`);
  console.log("baseline gravado em quality/baseline.json");
  process.exit(0);
}

const baseline = existsSync(join(dir, "baseline.json")) ? readJson("baseline.json") : {};
const targets = readJson("targets.json");
const { rows, regressions, improvements } = compare(current, baseline, targets);

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("métrica", 16)}${pad("atual", 10)}${pad("baseline", 11)}${pad("meta", 8)}situação`);
for (const r of rows) {
  const situacao = r.meta ? "meta atingida" : `faltam ${r.current - r.target}`;
  console.log(`${pad(r.metric, 16)}${pad(r.current, 10)}${pad(r.baseline ?? "-", 11)}${pad(r.target, 8)}${situacao}`);
}

for (const r of regressions) console.error(`${r.metric}: ${r.baseline} -> ${r.current} (piorou em relação ao baseline)`);
if (regressions.length > 0) {
  console.error("\nqualidade: regressão. Corrija o código; não regrave o baseline para esconder.");
  process.exit(1);
}
if (improvements.length > 0) {
  console.log(`\n${improvements.length} melhoria(s): rode "npm run quality:baseline" e commite o baseline menor.`);
}
console.log("\nqualidade: sem regressões em relação ao baseline");
