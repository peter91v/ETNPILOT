import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { WorktreeManager } from "../src/git/worktrees.js";

test("worktree manager creates an isolated feature branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-git-"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "test\n");
  await git(["add", "README.md"], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  const manager = new WorktreeManager(root);
  const created = await manager.create({ name: "run-1", branch: "etnpilot/run-1" });
  const worktrees = await manager.list();
  assert.match(created.path, /.etnpilot\/worktrees\/run-1$/);
  assert.equal(worktrees.length, 2);

  await writeFile(join(created.path, "pending.txt"), "not committed\n");
  const retained = await manager.removeIfClean("run-1");
  assert.equal(retained.removed, false);
  assert.equal(retained.reason, "dirty-worktree");

  await unlink(join(created.path, "pending.txt"));
  const removed = await manager.removeIfClean("run-1");
  assert.equal(removed.removed, true);
  assert.equal((await manager.list()).length, 1);
});

test("worktree cleanup ignores ETNPilot's own workspace artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-git-artifacts-"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "test\n");
  await git(["add", "README.md"], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  const manager = new WorktreeManager(root);
  const created = await manager.create({ name: "run-2", branch: "etnpilot/run-2" });

  // The local CodeGraph index is written into every workspace ETNPilot runs in.
  await mkdir(join(created.path, ".codegraph"), { recursive: true });
  await writeFile(join(created.path, ".codegraph", "codegraph.db"), "index\n");

  const removed = await manager.removeIfClean("run-2");
  assert.equal(removed.removed, true);
  assert.equal((await manager.list()).length, 1);

  const second = await manager.create({ name: "run-3", branch: "etnpilot/run-3" });
  await mkdir(join(second.path, ".codegraph"), { recursive: true });
  await writeFile(join(second.path, ".codegraph", "codegraph.db"), "index\n");
  await writeFile(join(second.path, "work.txt"), "real work\n");

  const retained = await manager.removeIfClean("run-3");
  assert.equal(retained.removed, false);
  assert.equal(retained.reason, "dirty-worktree");
  assert.equal(retained.status, "?? work.txt");

  await manager.deleteBranch("etnpilot/run-2");
  assert.deepEqual(
    (await git(["branch", "--list", "etnpilot/*", "--format=%(refname:short)"], { cwd: root })).stdout.split("\n"),
    ["etnpilot/run-3"],
  );
});
