import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorktreeLock, worktreeLockHolder } from "../src/runtime/worktree-lock.js";

async function root() {
  return mkdtemp(join(tmpdir(), "etnpilot-lock-"));
}

test("a second run in the same worktree is refused until the first lets go", async () => {
  const dir = await root();
  const first = await acquireWorktreeLock(dir, "/work/tree", { label: "resuming run-1" });
  await assert.rejects(acquireWorktreeLock(dir, "/work/tree"), (error) => error.code === "worktree_busy" && /Another run is working in this worktree/.test(error.message) && /resuming run-1/.test(error.message));
  assert.equal((await worktreeLockHolder(dir, "/work/tree")).pid, process.pid);
  // Another worktree is another lock.
  const other = await acquireWorktreeLock(dir, "/work/other");
  await other.release();
  await first.release();
  assert.equal(await worktreeLockHolder(dir, "/work/tree"), undefined);
  await (await acquireWorktreeLock(dir, "/work/tree")).release();
});

test("a lock whose process is gone does not hold a worktree for good", async () => {
  const dir = await root();
  const held = await acquireWorktreeLock(dir, "/work/tree");
  await writeFile(held.path, JSON.stringify({ pid: 2 ** 22 - 1, since: new Date().toISOString() }));
  assert.equal(await worktreeLockHolder(dir, "/work/tree"), undefined, "a dead process holds nothing");
  const again = await acquireWorktreeLock(dir, "/work/tree");
  assert.equal((await worktreeLockHolder(dir, "/work/tree")).pid, process.pid);
  await again.release();
});

test("a lock file that cannot be read, or is a day old, is not a holder", async () => {
  const dir = await root();
  const held = await acquireWorktreeLock(dir, "/work/tree");
  await writeFile(held.path, "not json");
  assert.equal(await worktreeLockHolder(dir, "/work/tree"), undefined);
  await writeFile(held.path, JSON.stringify({ pid: process.pid, since: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
  assert.equal(await worktreeLockHolder(dir, "/work/tree"), undefined);
  await mkdir(join(dir, ".etnpilot", "state", "locks"), { recursive: true });
  assert.equal((await readdir(join(dir, ".etnpilot", "state", "locks"))).length, 1);
});
