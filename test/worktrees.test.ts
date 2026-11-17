import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeases, releaseLease, type WorktreeOps } from "../src/worktrees.ts";

const STATUS = `A new version of treehouse is available
1     leased       ~/.treehouse/al-0802e3/1/al  (held by t-e19b2fae)
2     available    ~/.treehouse/al-0802e3/2/al
3     leased       ~/.treehouse/al-0802e3/3/al  (held by implement-x)
`;

/** Ops simulados: árvore com estado controlado por teste. */
function fakeOps(over: Partial<{ dirty: string; remoteContains: string; returned: string[] }> = {}): WorktreeOps & { returned: string[] } {
  const returned: string[] = [];
  return {
    returned,
    status: () => STATUS,
    git: (_path, args) => {
      if (args[0] === "status") return over.dirty ?? "";
      if (args[0] === "branch") return over.remoteContains ?? "  origin/master";
      throw new Error("git inesperado " + args.join(" "));
    },
    returnTree: (path) => {
      returned.push(path);
    },
  };
}

test("parseLeases pega só arrendamentos com titular e expande ~", () => {
  const leases = parseLeases(STATUS, "/home/u");
  assert.deepEqual(leases.map((l) => [l.holder, l.path]), [
    ["t-e19b2fae", "/home/u/.treehouse/al-0802e3/1/al"],
    ["implement-x", "/home/u/.treehouse/al-0802e3/3/al"],
  ]);
});

test("devolve a worktree de uma tarefa limpa e já enviada", () => {
  const ops = fakeOps();
  const note = releaseLease(ops, "/repo", "t-e19b2fae", "/home/u");
  assert.equal(note.released, true);
  assert.deepEqual(ops.returned, ["/home/u/.treehouse/al-0802e3/1/al"]);
});

test("não devolve com alterações não commitadas e diz o caminho", () => {
  const ops = fakeOps({ dirty: " M src/x.ts" });
  const note = releaseLease(ops, "/repo", "t-e19b2fae", "/home/u");
  assert.equal(note.released, false);
  assert.match(note.message, /alterações não commitadas/);
  assert.match(note.message, /\.treehouse\/al-0802e3\/1\/al/);
  assert.deepEqual(ops.returned, []);
});

test("não devolve commit que não existe em nenhum remoto", () => {
  const ops = fakeOps({ remoteContains: "" });
  const note = releaseLease(ops, "/repo", "t-e19b2fae", "/home/u");
  assert.equal(note.released, false);
  assert.match(note.message, /commit sem push/);
  assert.deepEqual(ops.returned, []);
});

test("titular que não é a tarefa não é tocado", () => {
  const ops = fakeOps();
  const note = releaseLease(ops, "/repo", "t-nao-existe", "/home/u");
  assert.equal(note.released, false);
  assert.deepEqual(ops.returned, []);
});
