import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

const layers = ["orchestrator", "worker", "shared", "policy"] as const;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]);
  return specs.map((spec) => resolve(dirname(file), spec));
}

function layerOf(file: string): string | null {
  const rel = relative(src, file);
  const top = rel.split("/")[0];
  return (layers as readonly string[]).includes(top) ? top : null;
}

function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !file.startsWith(src) || !existsSync(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

test("as quatro camadas existem em src/", () => {
  for (const layer of layers) {
    assert.ok(existsSync(join(src, layer)), `falta src/${layer}/`);
  }
});

test("worker não alcança orchestrator, nem por import direto nem transitivo", () => {
  const entry = join(src, "worker-ext.ts");
  const hits = [...reachable(entry)].filter((f) => layerOf(f) === "orchestrator");
  assert.deepEqual(
    hits.map((f) => relative(src, f)),
    [],
  );
});

test("orchestrator não alcança worker: sem ciclo entre as duas camadas", () => {
  const entries = tsFiles(join(src, "orchestrator"));
  const hits = entries.flatMap((entry) =>
    [...reachable(entry)]
      .filter((f) => layerOf(f) === "worker")
      .map((f) => `${relative(src, entry)} -> ${relative(src, f)}`),
  );
  assert.deepEqual(hits, []);
});

test("shared e policy não dependem de orchestrator nem de worker", () => {
  for (const layer of ["shared", "policy"] as const) {
    for (const entry of tsFiles(join(src, layer))) {
      const bad = [...reachable(entry)].filter((f) => ["orchestrator", "worker"].includes(layerOf(f) ?? ""));
      assert.deepEqual(
        bad.map((f) => `${relative(src, entry)} -> ${relative(src, f)}`),
        [],
        `${layer} depende de camada de aplicação`,
      );
    }
  }
});

test("worker não invoca ferramentas orch_* de coordenação", () => {
  const coordination =
    /"orch_(delegate|fix_red_prs|send|relaunch|answer|close|cancel|release|plan_\w+|status|inbox|logs|idle|usage|locate_project)"/;
  for (const file of tsFiles(join(src, "worker"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), coordination, relative(src, file));
  }
  assert.doesNotMatch(readFileSync(join(src, "worker-ext.ts"), "utf8"), coordination);
});
