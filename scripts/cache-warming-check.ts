// Diagnóstico reproduzível do cache warming do Pi (sem chamadas a provedores).
// Uso: npm run cache:check
// Não imprime valores de models.json (pode conter credenciais); só contagens.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_WARMING_ENV, cacheWarmingOverride } from "../src/orchestrator/cache-warming.ts";

const modelsPath = join(homedir(), ".pi", "agent", "models.json");
const promptCacheEntries = existsSync(modelsPath)
  ? (readFileSync(modelsPath, "utf8").match(/"promptCache"/g) ?? []).length
  : null;

console.log("Elegibilidade (promptCache declarado em ~/.pi/agent/models.json):");
if (promptCacheEntries === null) console.log("  models.json ausente: nenhum modelo com promptCache");
else
  console.log(
    `  entradas promptCache: ${promptCacheEntries}${promptCacheEntries === 0 ? " (sem elegibilidade: warming inativo)" : ""}`,
  );

console.log("\nOverride do orquestrador:");
for (const value of [undefined, "idle", "off"]) {
  const result = cacheWarmingOverride({ [CACHE_WARMING_ENV]: value });
  console.log(
    `  ${CACHE_WARMING_ENV}=${value ?? "(não definida)"} -> ${result ? JSON.stringify(result) : "decisão do Pi"}`,
  );
}

console.log("\nNÃO MEDIDO: A/B com provedores reais, idle de 10–30 min, cacheRead/cacheWrite e custo por modelo.");
