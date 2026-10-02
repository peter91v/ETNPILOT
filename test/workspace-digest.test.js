import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { workspaceDigest } from "../src/git/workspace-digest.js";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-digest-"));
  await git(["init", "-q"], { cwd: root });
  await git(["config", "user.email", "t@example.com"], { cwd: root });
  await git(["config", "user.name", "t"], { cwd: root });
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-qm", "base"], { cwd: root });
  return root;
}

test("the digest changes with a change, a new file, and not with anything else", async () => {
  const root = await repository();
  const clean = await workspaceDigest(root);
  assert.match(clean.digest, /^git:[0-9a-f]{40}:[0-9a-f]{40}$/);
  assert.equal((await workspaceDigest(root)).digest, clean.digest, "same files, same digest");

  await writeFile(join(root, "ignored.txt"), "not part of the repository\n");
  assert.equal((await workspaceDigest(root)).digest, clean.digest, "ignored files do not count");

  await writeFile(join(root, "a.txt"), "two\n");
  const edited = await workspaceDigest(root);
  assert.notEqual(edited.digest, clean.digest);
  await writeFile(join(root, "new.txt"), "x\n");
  const added = await workspaceDigest(root);
  assert.notEqual(added.digest, edited.digest);
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "new.txt"), "x\n");
  assert.notEqual((await workspaceDigest(root)).digest, clean.digest);
});

test("taking the digest leaves the staging area and the working tree alone", async () => {
  const root = await repository();
  await writeFile(join(root, "new.txt"), "untracked\n");
  await workspaceDigest(root);
  const status = (await git(["status", "--porcelain"], { cwd: root, trim: false })).stdout;
  assert.equal(status, "?? new.txt\n", "the new file is still untracked, nothing was staged");
});

test("a directory that is not a repository has no digest, and says why", async () => {
  const plain = await mkdtemp(join(tmpdir(), "etnpilot-nogit-"));
  const result = await workspaceDigest(plain);
  assert.equal(result.digest, undefined);
  assert.match(result.unavailable, /git/);
});
