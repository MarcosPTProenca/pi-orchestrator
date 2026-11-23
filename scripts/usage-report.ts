import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { usageReport } from "../src/shared/usage.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("uso: usage-report <sessao.jsonl> [mais sessões...]");
  process.exit(2);
}
const sessions = paths.map((p) =>
  readFileSync(resolve(p), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown),
);
const limites = [
  "origem do turno indisponível no Pi; by_origin classifica só pelo gatilho observado",
  "usuario = mensagem de usuário do Pi, inclui prompts enviados por automação pelo terminal",
  "automatico = mensagem de extensão (custom_message) ou continuidade após ferramenta",
  "sem conteúdo de prompt: só contagens e somas",
];
console.log(JSON.stringify({ ...usageReport(sessions), limites }, null, 2));
