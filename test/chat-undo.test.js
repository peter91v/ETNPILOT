import assert from "node:assert/strict";
import { access, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git/command.js";
import { evalApprovalHandler, prepareEvalWorkspace } from "../src/runtime/evals.js";
import { historyFrom, readSession, runChatTurn, undoLastTurn } from "../src/runtime/chat-session.js";
import { diffSnapshots, snapshotTree } from "../src/runtime/chat-snapshots.js";

// D5: taking a turn back. The files before and after each turn are recorded as
// git trees; undo puts back only what the turn left untouched since.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-undo-"));
  await prepareEvalWorkspace({ task: "chat", files: { "README.md": "# fixture\n", "src/a.js": "export const a = 1;\n" }, scripted: [] }, root);
  return root;
}

// A provider that changes files the way an agent would have, by name.
function editing(actions) {
  return {
    scripted: async () => ({
      name: "scripted",
      capabilities: ["chat"],
      async invoke(context) {
        for (const action of actions[context.input] ?? []) await action(context);
        return { text: `did: ${context.input}`, model: "m" };
      },
    }),
  };
}

const turn = (root, sessionId, text, actions) => runChatTurn({
  root, sessionId, text, agent: "orchestrator", providerFactories: editing(actions), approvalHandler: evalApprovalHandler(),
});

const exists = (path) => access(path).then(() => true, () => false);

test("undo puts back what the turn added and changed", async () => {
  const root = await project();
  const first = await turn(root, undefined, "edit", {
    edit: [
      () => writeFile(join(root, "notes.txt"), "ready\n"),
      () => writeFile(join(root, "README.md"), "# changed\n"),
      () => unlink(join(root, "src", "a.js")),
    ],
  });
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "ready\n");
  assert.equal(await exists(join(root, "src", "a.js")), false);

  const undone = await undoLastTurn({ root, sessionId: first.sessionId });
  assert.equal(undone.ok, true);
  assert.deepEqual([...undone.reverted].sort(), ["README.md", "notes.txt", "src/a.js"]);
  assert.equal(await exists(join(root, "notes.txt")), false);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "# fixture\n");
  assert.equal(await readFile(join(root, "src", "a.js"), "utf8"), "export const a = 1;\n");

  // The conversation remembers that it happened, and that it was taken back.
  const session = await readSession(root, first.sessionId);
  assert.ok(session.turns[0].undone);
  assert.match(historyFrom(session.turns)[1].content, /undid this turn's changes/);
  assert.equal((await undoLastTurn({ root, sessionId: first.sessionId })).ok, false);
});

test("a file the person changed since is left alone, and named", async () => {
  const root = await project();
  const first = await turn(root, undefined, "edit", {
    edit: [() => writeFile(join(root, "notes.txt"), "agent\n"), () => writeFile(join(root, "README.md"), "# agent\n")],
  });
  await writeFile(join(root, "notes.txt"), "agent\nand my own line\n");
  const undone = await undoLastTurn({ root, sessionId: first.sessionId });
  assert.deepEqual(undone.reverted, ["README.md"]);
  assert.deepEqual(undone.skipped.map((entry) => entry.path), ["notes.txt"]);
  assert.match(undone.message, /left notes\.txt: it was changed since the turn/);
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "agent\nand my own line\n");
});

test("turns are undone newest first, and a turn that changed nothing says so", async () => {
  const root = await project();
  const one = await turn(root, undefined, "one", { one: [() => writeFile(join(root, "one.txt"), "1")] });
  await turn(root, one.sessionId, "two", { two: [() => writeFile(join(root, "two.txt"), "2")] });
  await turn(root, one.sessionId, "three", {});

  const third = await undoLastTurn({ root, sessionId: one.sessionId });
  assert.match(third.message, /Turn 3 changed no files/);
  const second = await undoLastTurn({ root, sessionId: one.sessionId });
  assert.deepEqual(second.reverted, ["two.txt"]);
  assert.equal(await exists(join(root, "one.txt")), true);
  const first = await undoLastTurn({ root, sessionId: one.sessionId });
  assert.deepEqual(first.reverted, ["one.txt"]);
  assert.equal((await undoLastTurn({ root, sessionId: one.sessionId })).ok, false);
});

test("the person's staging area is never touched, and ETNPilot's own state is not the agent's work", async () => {
  const root = await project();
  await writeFile(join(root, "staged.txt"), "mine\n");
  await git(["add", "staged.txt"], { cwd: root });
  const before = (await git(["diff", "--cached", "--name-only"], { cwd: root })).stdout;

  const first = await turn(root, undefined, "edit", { edit: [() => writeFile(join(root, "notes.txt"), "x")] });
  assert.equal((await git(["diff", "--cached", "--name-only"], { cwd: root })).stdout, before);
  await undoLastTurn({ root, sessionId: first.sessionId });
  assert.equal((await git(["diff", "--cached", "--name-only"], { cwd: root })).stdout, before);

  // The turn wrote receipts, sessions and a database under .etnpilot/state; none
  // of that is in the difference between the two recorded trees.
  const { turns } = await readSession(root, first.sessionId);
  const changes = await diffSnapshots(root, turns[0].snapshots.before, turns[0].snapshots.after);
  assert.deepEqual(changes.map((change) => change.path), ["notes.txt"]);
});

test("a turn without a snapshot says why it cannot be undone", async () => {
  const bare = await mkdtemp(join(tmpdir(), "etnpilot-nogit-"));
  assert.equal(await snapshotTree(bare), undefined);

  const root = await project();
  await git(["rev-parse", "--git-dir"], { cwd: root });
  const first = await turn(root, undefined, "edit", {});
  const session = await readSession(root, first.sessionId);
  // (In a repository the record is there; the message for its absence is exercised below.)
  assert.ok(session.turns[0].snapshots.before);
  const { appendTurn } = await import("../src/runtime/chat-session.js");
  await appendTurn(root, "s-legacy-01", { turn: 1, at: "x", agent: "a", input: "i", status: "succeeded", reply: "r", snapshots: { unavailable: "not a git repository" } });
  const legacy = await undoLastTurn({ root, sessionId: "s-legacy-01" });
  assert.equal(legacy.ok, false);
  assert.match(legacy.message, /cannot be undone: no snapshot was taken \(not a git repository\)/);
});
