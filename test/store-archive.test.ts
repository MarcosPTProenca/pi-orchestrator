import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../src/shared/contract.ts";
import { Store } from "../src/shared/store.ts";
import { buildStatus } from "../src/orchestrator/status.ts";
import { appendHistory } from "../src/shared/history.ts";
import { makeHarness, reopenHarness } from "./fakes.ts";

function task(task_id: string, status: TaskRecord["status"], updated_at: string): TaskRecord {
  return {
    task_id,
    project_id: "project",
    project_path: "/project",
    role: "worker",
    worker_id: "worker",
    workspace_id: "workspace",
    tab_id: "tab",
    pane_id: "pane",
    terminal_id: "terminal",
    status,
    task_dir: `/tasks/${task_id}`,
    brief_path: `/tasks/${task_id}/brief.md`,
    created_at: updated_at,
    updated_at,
    deadline_at: null,
    question: null,
    result: `result ${task_id}`,
    artifacts: [],
    last_report_key: null,
    notified: false,
    error: null,
    model: null,
  };
}

test("archive move old terminal tasks to monthly files and keeps active/recent tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-archive-"));
  const file = join(dir, "state.json");
  const now = Date.parse("2026-11-27T12:00:00Z");
  const old = task("old", "done", "2026-10-31T11:59:59.999Z");
  const oldFailed = task("old-failed", "failed", "2026-10-15T12:00:00.000Z");
  const oldCancelled = task("old-cancelled", "cancelled", "2026-10-14T12:00:00.000Z");
  const oldTimeout = task("old-timeout", "timeout", "2026-10-13T12:00:00.000Z");
  const oldLost = task("old-lost", "lost", "2026-10-12T12:00:00.000Z");
  const exactBoundary = task("boundary", "cancelled", new Date(now - 14 * 86_400_000).toISOString());
  const fresh = task("fresh", "timeout", new Date(now - 13 * 86_400_000).toISOString());
  const active = task("active", "running", "2026-09-01T00:00:00.000Z");
  const planned = task("planned", "planned", "2026-09-01T00:00:00.000Z");
  const starting = task("starting", "starting", "2026-09-01T00:00:00.000Z");
  const blocked = task("blocked", "blocked", "2026-09-01T00:00:00.000Z");
  const store = new Store(file);
  const tasks = [
    old,
    oldFailed,
    oldCancelled,
    oldTimeout,
    oldLost,
    exactBoundary,
    fresh,
    active,
    planned,
    starting,
    blocked,
  ];
  store.save({
    version: 1,
    tasks: Object.fromEntries(tasks.map((t) => [t.task_id, t])),
    workspaces: { p: { workspace_id: "w", seeded_tab_id: null } },
  });

  try {
    assert.equal(store.archiveOldTasks(now), 5);
    assert.deepEqual(Object.keys(store.load().tasks).sort(), [
      "active",
      "blocked",
      "boundary",
      "fresh",
      "planned",
      "starting",
    ]);
    assert.deepEqual(Object.keys(store.load().workspaces), ["p"]);
    const october = JSON.parse(readFileSync(join(dir, "archive", "2026-10.json"), "utf8")) as {
      tasks: Record<string, TaskRecord>;
    };
    assert.deepEqual(october.tasks, {
      old,
      "old-failed": oldFailed,
      "old-cancelled": oldCancelled,
      "old-timeout": oldTimeout,
      "old-lost": oldLost,
    });
    assert.equal(existsSync(`${file}.bak`), true);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")), {
      version: 1,
      tasks: Object.fromEntries(tasks.map((t) => [t.task_id, t])),
      workspaces: { p: { workspace_id: "w", seeded_tab_id: null } },
    });
    assert.deepEqual(
      buildStatus(Object.values(store.loadAll().tasks), now, { all: true })
        .flatMap((group) => group.tasks.map((item) => item.task_id))
        .sort(),
      [
        "active",
        "blocked",
        "boundary",
        "fresh",
        "old",
        "old-cancelled",
        "old-failed",
        "old-lost",
        "old-timeout",
        "planned",
        "starting",
      ],
    );
    assert.equal(store.archiveOldTasks(now), 0, "second run is idempotent");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "archive", "2026-10.json"), "utf8")), october);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archived task records stay readable through status and history", () => {
  const h = makeHarness();
  const old = task("old-history", "done", "2026-10-01T00:00:00.000Z");
  old.task_dir = join(h.stateDir, "tasks", old.task_id);
  old.brief_path = join(old.task_dir, "brief.md");
  writeFileSync(
    join(h.stateDir, "state.json"),
    JSON.stringify({ version: 1, tasks: { [old.task_id]: old }, workspaces: {} }),
  );
  appendHistory(old.task_dir, {
    at: old.updated_at,
    from: "worker",
    to: "orquestrador",
    kind: "relatorio",
    status: "done",
    ref: null,
    text: "resultado histórico",
  });
  try {
    const restarted = reopenHarness(h);
    const store = new Store(join(h.stateDir, "state.json"));
    assert.deepEqual(
      store.load().tasks,
      { [old.task_id]: old },
      "constructing a read-only orchestrator does not archive",
    );
    store.archiveOldTasks(h.clock.ms);
    assert.deepEqual(store.load().tasks, {});
    assert.equal(restarted.list()[0].task_id, old.task_id);
    assert.equal(restarted.get(old.task_id).result, old.result);
    assert.equal(restarted.history(old.task_id, {}).items[0].text, "resultado histórico");
  } finally {
    rmSync(h.stateDir, { recursive: true, force: true });
    rmSync(h.project, { recursive: true, force: true });
  }
});

test("archive failure leaves active state intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-archive-failure-"));
  const file = join(dir, "state.json");
  const now = Date.parse("2026-11-27T12:00:00Z");
  const old = task("old", "lost", "2026-10-01T00:00:00.000Z");
  const store = new Store(file);
  store.save({ version: 1, tasks: { old }, workspaces: {} });
  try {
    writeFileSync(join(dir, "archive"), "not a directory");
    assert.throws(() => store.archiveOldTasks(now));
    assert.deepEqual(store.load().tasks, { old });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
