import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
});
