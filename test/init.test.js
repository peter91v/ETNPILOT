import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { initializeProject } from "../src/config/init.js";

test("init keeps run state and worktrees out of the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-init-"));
  await git(["init", "-b", "main"], { cwd: root });
  await initializeProject(root);

  const ignore = await readFile(join(root, ".etnpilot", ".gitignore"), "utf8");
  assert.match(ignore, /^state\/$/m);
  assert.match(ignore, /^worktrees\/$/m);
  assert.match(ignore, /^keys\/$/m);

  await writeFile(join(root, ".etnpilot", "state", "run.jsonl"), "{}\n");
  await writeFile(join(root, ".etnpilot", "state", "codegraph.sqlite"), "");
  const status = await git(["status", "--porcelain"], { cwd: root });
  assert.equal(status.stdout.includes(".etnpilot/state"), false, status.stdout);
});

test("init never overwrites an existing configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-init-existing-"));
  await initializeProject(root);
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\ncustom: true\n");
  await writeFile(join(root, ".etnpilot", ".gitignore"), "custom-ignore\n");

  await initializeProject(root);
  assert.match(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"), /custom: true/);
  assert.equal(await readFile(join(root, ".etnpilot", ".gitignore"), "utf8"), "custom-ignore\n");
});
