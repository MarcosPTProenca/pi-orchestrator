import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCli } from "../src/shared/herdr.ts";
import { workerTabName } from "../src/shared/label.ts";

function fakeHerdr(): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1","terminal_id":"term1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p2","terminal_id":"term2"}}}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

test("criar workspace e tab nunca toma o foco do usuário", async () => {
  const fake = fakeHerdr();
  const herdr = new HerdrCli(fake.bin);
  await herdr.createWorkspace({ cwd: "/x/proj", label: "proj" });
  await herdr.createTab({
    workspaceId: "w1",
    cwd: "/x/proj",
    label: workerTabName("issue-224", "e01fd3c6"),
    env: {},
  });
  const calls = fake.calls();
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /--no-focus/, `sem --no-focus: ${c}`);
});

test("tab do worker sai com o título legível e o id curto", async () => {
  const fake = fakeHerdr();
  const herdr = new HerdrCli(fake.bin);
  const label = workerTabName("issue-224", "e01fd3c6");
  await herdr.createTab({ workspaceId: "w1", cwd: "/x/proj", label, env: {} });
  const [call] = fake.calls();
  assert.ok(call.includes(`--label ${label}`), call);
  assert.equal(label, "worker-issue-224-e01fd3");
});

test("fechar um worker fecha só a tab dele, sem tocar o workspace", async () => {
  const fake = fakeHerdr();
  const herdr = new HerdrCli(fake.bin);
  await herdr.closeTab("w1:t2");
  const calls = fake.calls();
  assert.deepEqual(calls, ["tab close w1:t2"]);
  assert.ok(!calls.some((c) => c.startsWith("workspace close")), "workspace do projeto preservado");
});
