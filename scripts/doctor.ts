import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { formatDoctor, parseManifest, realProbe, runDoctor, type Profile } from "./setup-lib.ts";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const idx = process.argv.indexOf("--profile");
const value = idx >= 0 ? process.argv[idx + 1] : "minimal";
if (value !== "minimal" && value !== "complete") {
  console.error(`perfil desconhecido: ${String(value)} (use minimal ou complete)`);
  process.exit(2);
}
const profile: Profile = value;
const manifest = parseManifest(readFileSync(join(root, "setup", "dependencies.json"), "utf8"));
const report = runDoctor(manifest, realProbe(root), profile);
console.log(formatDoctor(profile, report));
process.exit(report.missing === 0 ? 0 : 1);
