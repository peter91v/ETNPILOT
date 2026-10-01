import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git/command.js";
import { initializeProject } from "../src/config/init.js";
import { checkRunReadiness } from "../src/runtime/project-state.js";
import { createReviewServer } from "../src/ui/server.js";

// A run works in a worktree made from the committed base ref. A project whose
// '.etnpilot/' was never committed used to be accepted (202) and then fail in
// the background with a sentence that told the person to go to a terminal.

async function project({ commit }) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ready-"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "t@example.com"], { cwd: root });
  await git(["config", "user.name", "t"], { cwd: root });
  await writeFile(join(root, "README.md"), "x\n");
  await git(["add", "README.md"], { cwd: root });
  await git(["commit", "-m", "first"], { cwd: root });
  await initializeProject(root, { forge: false, importExisting: false });
  if (commit) {
    await git(["add", ".etnpilot"], { cwd: root });
    await git(["commit", "-m", "etnpilot"], { cwd: root });
  }
  return root;
}

test("a committed project is ready; an uncommitted one says what to do", async () => {
  const ready = await checkRunReadiness({ root: await project({ commit: true }), config: {} });
  assert.equal(ready.ready, true);

  const notReady = await checkRunReadiness({ root: await project({ commit: false }), config: {} });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.code, "project-not-committed");
  assert.match(notReady.message, /no '\.etnpilot\/etnpilot\.yaml'/);
  assert.deepEqual(notReady.fixes, ["in-place"]);
  assert.match(notReady.commands[0], /git add \.etnpilot/);

  const elsewhere = await mkdtemp(join(tmpdir(), "etnpilot-nogit-"));
  assert.equal((await checkRunReadiness({ root: elsewhere, config: {} })).code, "not-a-checkout");
  assert.equal((await checkRunReadiness({ root: elsewhere, config: { workspace: { mode: "in-place" } } })).ready, true);
});

test("the page's start refuses with the way out instead of accepting a run that will fail", async () => {
  const root = await project({ commit: false });
  const review = await createReviewServer({ root });
  const address = await review.listen({ port: 0 });
  try {
    const call = (path, options = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...options,
      headers: { "x-etnpilot-token": review.token, "content-type": "application/json" },
    });
    const readiness = await (await call("/api/runs/readiness")).json();
    assert.equal(readiness.ready, false);

    const refused = await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "do it" }) });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.code, "project-not-committed");
    assert.deepEqual(body.fixes, ["in-place"]);
    assert.ok(body.commands.length > 0);

    // Choosing to work in place is accepted: the run is started, not refused.
    const accepted = await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "do it", worktree: false }) });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).inPlace, true);
  } finally {
    await review.close?.();
  }
});
