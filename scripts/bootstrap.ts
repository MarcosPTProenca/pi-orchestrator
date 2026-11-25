import { fileURLToPath } from "node:url";
import { bootstrap, realRunner } from "./setup-lib.ts";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
try {
  const steps = bootstrap(root, realRunner, process.versions.node, "22.18.0");
  for (const s of steps) console.log(`${s.name}: ${s.outcome}`);
  console.log("escopo local do repo; ~/.pi/agent não foi tocado. Próximo passo: npm run doctor");
} catch (err) {
  console.error(`bootstrap falhou: ${(err as Error).message}`);
  process.exit(1);
}
