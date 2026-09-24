import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStyle, stripAnsi } from "../src/tui/ansi.js";
import { mergeEntries, renderApp, renderMerges, renderWorktreeChanges, renderWorktrees } from "../src/tui/render.js";
import { createTuiApp } from "../src/tui/app.js";
import { git } from "../src/git/command.js";
import { WorktreeManager } from "../src/git/worktrees.js";
import { openProjectState, parseDiff, readMergeRequests, readWorktrees } from "../src/runtime/project-state.js";

const style = createStyle({ color: false });

test("a worktree is described by the branch it holds and the work it would lose", async () => {
  const root = await createRepository();
  const manager = new WorktreeManager(root);
  await manager.create({ name: "run-9f2a1c44", branch: "etnpilot/run-9f2a1c44" });
  await manager.create({ name: "run-7e1b0a33", branch: "etnpilot/run-7e1b0a33" });
  await writeFile(join(root, ".etnpilot", "worktrees", "run-7e1b0a33", "draft.txt"), "unsaved\n");
  // ETNPilot writes its own state into a workspace; that is not unsaved work.
  await mkdir(join(root, ".etnpilot", "worktrees", "run-9f2a1c44", ".etnpilot", "state"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "worktrees", "run-9f2a1c44", ".etnpilot", "state", "runs.jsonl"), "{}\n");

  const described = await manager.describe();
  const byName = Object.fromEntries(described.map((entry) => [entry.name, entry]));
  assert.equal(described.length, 3);
  assert.equal(byName["run-9f2a1c44"].branch, "etnpilot/run-9f2a1c44");
  assert.equal(byName["run-9f2a1c44"].managed, true);
  assert.equal(byName["run-9f2a1c44"].blocking, 0);
  assert.equal(byName["run-9f2a1c44"].removable, true, "an ETNPilot artifact does not block removal");
  assert.equal(byName["run-7e1b0a33"].blocking, 1);
  assert.equal(byName["run-7e1b0a33"].removable, false);
  // The checkout the person works in is never removable from a surface.
  const main = described.find((entry) => entry.main);
  assert.equal(main.managed, false);
  assert.equal(main.removable, false);

  const collected = await readWorktrees({ root, config: {} });
  assert.deepEqual(
    { available: collected.available, managed: collected.managed, unsaved: collected.unsaved },
    { available: true, managed: 2, unsaved: 1 },
  );
});

test("a directory that is not a checkout says so instead of looking empty", async () => {
  const outside = await mkdtemp(join(tmpdir(), "etnpilot-nogit-"));
  const collected = await readWorktrees({ root: outside, config: {} });
  assert.equal(collected.available, false);
  assert.match(collected.error, /not a git repository/);
  const frame = renderWorktrees({}, { style, width: 80, height: 12, cursor: 0, worktrees: collected }).join("\n");
  assert.match(frame, /could not be listed/);
  assert.match(frame, /not a git repository/);
});

test("the worktrees view names what each worktree holds", () => {
  const worktrees = {
    available: true,
    managed: 1,
    unsaved: 1,
    entries: [
      { name: "service", path: "/w/service", branch: "main", head: "acf77cb7abcd", managed: false, main: true, readable: true, changes: 0, blocking: 0, removable: false },
      { name: "run-9f2a1c44", path: "/w/.etnpilot/worktrees/run-9f2a1c44", branch: "etnpilot/run-9f2a1c44", head: "b12c3d4e5678", managed: true, main: false, readable: true, changes: 3, blocking: 2, removable: false },
    ],
  };
  const frame = renderWorktrees({}, { style, width: 100, height: 14, cursor: 1, worktrees }).join("\n");
  assert.match(frame, /2 worktrees · 1 from runs · 1 with unsaved work/);
  assert.match(frame, /etnpilot\/run-9f2a1c44/);
  assert.match(frame, /2 unsaved/);
  assert.match(frame, /acf77cb7/);
  // A key the footer promises must apply to something on screen, or say why not.
  assert.match(frame, /None of these can be removed from here/);

  assert.match(renderWorktrees({}, { style, width: 80, height: 10 }).join("\n"), /Reading the worktrees/);
});

test("removing a worktree from the screen never discards unsaved work", async () => {
  const root = await createRepository();
  const manager = new WorktreeManager(root);
  await manager.create({ name: "run-dirty", branch: "etnpilot/run-dirty" });
  await manager.create({ name: "run-clean", branch: "etnpilot/run-clean" });
  await writeFile(join(root, ".etnpilot", "worktrees", "run-dirty", "draft.txt"), "unsaved\n");

  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter(), actor: "maintainer" });
  try {
    await app.refresh();
    await app.handle("5");
    assert.equal(app.view, "worktrees");
    // The view reads on demand, so the first frame says it is reading.
    assert.match(stripAnsi(app.frame().join("\n")), /Reading the worktrees/);
    await app.handle("g");
    assert.equal(app.worktrees.entries.length, 3);

    const dirty = app.worktrees.entries.findIndex((entry) => entry.name === "run-dirty");
    await moveTo(app, dirty);
    await app.handle("x");
    assert.match(app.message, /keeps 1 unsaved change/);
    assert.ok(await exists(manager, "run-dirty"), "the worktree is still there");

    const clean = app.worktrees.entries.findIndex((entry) => entry.name === "run-clean");
    await moveTo(app, clean);
    await app.handle("x");
    assert.match(app.message, /run-clean is gone/);
    assert.equal(await exists(manager, "run-clean"), false);
    assert.equal(app.worktrees.entries.some((entry) => entry.name === "run-clean"), false);

    // The checkout a person works in is refused with a reason, not removed.
    await moveTo(app, app.worktrees.entries.findIndex((entry) => entry.main));
    await app.handle("x");
    assert.match(app.message, /not a worktree ETNPilot made/);
  } finally {
    app.stop();
    state.close();
  }
});

test("merge requests are read from GitLab, with ours told apart by their branch", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), token: options.headers["private-token"] });
    return jsonResponse([
      {
        iid: 42, title: "Draft: ETNPilot: add a health check", state: "opened", draft: true,
        source_branch: "etnpilot/run-9f2a1c44", target_branch: "main", web_url: "https://gitlab.test/x/-/merge_requests/42",
        updated_at: "2026-09-23T10:00:00Z", detailed_merge_status: "mergeable", author: { username: "etnpilot-bot" },
      },
      {
        // Somebody else's title is data: control characters cannot forge a row.
        iid: 39, title: "Split the scheduler\u001B[2J out of the worker", state: "opened",
        source_branch: "feature/scheduler", target_branch: "main", web_url: "https://gitlab.test/x/-/merge_requests/39",
        updated_at: "2026-09-23T11:00:00Z", merge_status: "cannot_be_merged", has_conflicts: true,
        author: { username: "mira" },
      },
    ]);
  };

  const merges = await readMergeRequests(
    { root: ".", config: { git: { project: "group/service", baseUrl: "https://gitlab.test", targetBranch: "main" } }, env: { ETNPILOT_GITLAB_TOKEN: "t0ken" } },
    { fetchImpl },
  );
  assert.equal(merges.available, true);
  assert.equal(merges.ours, 1);
  assert.equal(calls[0].token, "t0ken");
  assert.match(calls[0].url, /merge_requests/);
  const ours = merges.entries.find((entry) => entry.own);
  assert.equal(ours.iid, 42);
  assert.equal(ours.draft, true);
  const theirs = merges.entries.find((entry) => !entry.own);
  assert.equal(theirs.title.includes("\u001B"), false);
  assert.match(theirs.title, /\\u\{001b\}\[2J/);
  assert.equal(theirs.hasConflicts, true);

  // Ours are listed first, and the app selects from that same order.
  assert.deepEqual(mergeEntries(merges).map((entry) => entry.iid), [42, 39]);
  const frame = renderMerges({}, { style, width: 110, height: 16, cursor: 0, now: Date.now(), merges }).join("\n");
  assert.match(frame, /group\/service · 2 opened · 1 ours · target main/);
  assert.match(frame, /ours/);
  assert.match(frame, /conflicts/);
  assert.match(frame, /merge_requests\/42/, "the selected merge request shows its address");
});

test("a project with no GitLab settings, or no token, says which and stays usable", async () => {
  const unconfigured = await readMergeRequests({ root: ".", config: {}, env: {} });
  assert.equal(unconfigured.configured, false);
  assert.match(renderMerges({}, { style, width: 80, height: 10, merges: unconfigured }).join("\n"), /git\.project/);

  const untokened = await readMergeRequests({
    root: ".",
    config: { git: { project: "group/service", baseUrl: "https://gitlab.test" } },
    env: {},
  });
  assert.equal(untokened.available, false);
  assert.match(untokened.error, /token/);

  const refused = await readMergeRequests(
    { root: ".", config: { git: { project: "group/service", baseUrl: "https://gitlab.test" } }, env: { ETNPILOT_GITLAB_TOKEN: "t" } },
    { fetchImpl: async () => jsonResponse({ message: "401 Unauthorized" }, 401) },
  );
  assert.equal(refused.available, false);
  const frame = renderMerges({}, { style, width: 80, height: 12, merges: refused }).join("\n");
  assert.match(frame, /GitLab did not answer/);
  assert.match(frame, /'g' tries again/);
});

test("the two views are reachable, and the frame still fits", async () => {
  const root = await createRepository();
  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("\t");
    await app.handle("\t");
    await app.handle("\t");
    assert.equal(app.view, "settings", "the views people already use keep their keys");
    await app.handle("\t");
    assert.equal(app.view, "worktrees");
    await app.handle("\t");
    assert.equal(app.view, "merges");

    // The merge requests are never fetched behind your back: no project is
    // configured here, so the view says what to configure.
    await app.handle("g");
    assert.equal(app.merges.configured, false);
    const frame = app.frame();
    assert.equal(frame.length, 30);
    for (const line of frame) assert.ok(stripAnsi(line).length <= 100, `too wide: ${JSON.stringify(line)}`);
    assert.match(stripAnsi(frame.join("\n")), /merges/);

    const help = renderApp(await state.collect(), { width: 100, height: 30, color: false, help: true }).join("\n");
    assert.match(help, /remove it, if it is clean/);
    assert.match(help, /ask GitLab again/);
  } finally {
    app.stop();
    state.close();
  }
});

// ------------------------------------------------------------------ fixtures

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-wt-"));
  await git(["init", "--initial-branch=main", "."], { cwd: root });
  await git(["config", "user.email", "tests@etnpilot.local"], { cwd: root });
  await git(["config", "user.name", "ETNPilot tests"], { cwd: root });
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  await writeFile(join(root, "README.md"), "# fixture\n");
  await git(["add", "README.md", ".etnpilot/etnpilot.yaml"], { cwd: root });
  await git(["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function exists(manager, name) {
  const described = await manager.describe();
  return described.some((entry) => entry.name === name);
}

async function moveTo(app, index) {
  while (app.cursor > index) await app.handle("k");
  while (app.cursor < index) await app.handle("j");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeOutput() {
  const output = new EventEmitter();
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  output.written = [];
  output.write = (text) => output.written.push(text);
  return output;
}

test("opening a worktree says which files it is holding", async () => {
  const root = await createRepository();
  const manager = new WorktreeManager(root);
  await manager.create({ name: "run-dirty", branch: "etnpilot/run-dirty" });
  const workspace = join(root, ".etnpilot", "worktrees", "run-dirty");
  await writeFile(join(workspace, "draft.txt"), "unsaved\n");
  await writeFile(join(workspace, "README.md"), "# changed\n");
  await mkdir(join(workspace, ".etnpilot", "state"), { recursive: true });
  await writeFile(join(workspace, ".etnpilot", "state", "runs.jsonl"), "{}\n");

  const state = await openProjectState({ root });
  try {
    const changes = await state.worktreeChanges("run-dirty");
    const byPath = Object.fromEntries(changes.entries.map((entry) => [entry.path, entry]));
    // git counts what git tracks; an untracked file is entirely added.
    assert.deepEqual(
      { added: byPath["README.md"].added, deleted: byPath["README.md"].deleted },
      { added: 1, deleted: 1 },
    );
    assert.equal(byPath["draft.txt"].added, 1);
    assert.equal(byPath[".etnpilot/state/"].directory, true);
    // A modification is not an addition, and the artifacts ETNPilot writes
    // into a workspace are listed but marked as not a person's work.
    assert.equal(byPath["README.md"].label, "modified");
    assert.equal(byPath["README.md"].ignorable, false);
    assert.equal(byPath["draft.txt"].label, "untracked");
    assert.equal(byPath[".etnpilot/state/"].ignorable, true);
    assert.equal(changes.blocking, 2);

    // A name that is not a worktree of this project never reaches the disk.
    await assert.rejects(() => state.worktreeChanges("../elsewhere"), TypeError);
    await assert.rejects(() => state.worktreeChanges("run-absent"), TypeError);

    const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
    try {
      await app.refresh();
      await app.handle("5");
      await app.handle("g");
      const index = app.worktrees.entries.findIndex((entry) => entry.name === "run-dirty");
      await moveTo(app, index);
      await app.handle("\r");
      assert.equal(app.detail, true);
      const screen = stripAnsi(app.frame().join("\n"));
      // How much changed, not only that something did.
      assert.match(screen, /modified\s+\+1 −1 README\.md/);
      assert.match(screen, /untracked\s+\+1 draft\.txt/);
      // An untracked directory has no line count to give.
      assert.match(screen, /untracked\s+dir \.etnpilot\/state\//);
      assert.match(screen, /2 unsaved; removing is refused/);
      // Leaving the detail drops what it was showing rather than keeping it.
      await app.handle("\u001B");
      assert.equal(app.detail, false);
      assert.equal(app.worktreeChanges, undefined);
    } finally {
      app.stop();
    }
  } finally {
    state.close();
  }
});

test("a clean worktree says there is nothing to lose", async () => {
  const root = await createRepository();
  const manager = new WorktreeManager(root);
  await manager.create({ name: "run-clean", branch: "etnpilot/run-clean" });
  const state = await openProjectState({ root });
  try {
    const changes = await state.worktreeChanges("run-clean");
    assert.deepEqual(changes.entries, []);
    assert.equal(changes.blocking, 0);
    const worktrees = await state.worktrees();
    const frame = renderWorktreeChanges({}, {
      style,
      width: 90,
      height: 14,
      cursor: worktrees.entries.findIndex((entry) => entry.name === "run-clean"),
      worktrees,
      changes: { ...changes, name: "run-clean" },
    }).join("\n");
    assert.match(frame, /Nothing changed here/);
  } finally {
    state.close();
  }
});

test("a file in a worktree shows the lines it changed", async () => {
  const root = await createRepository();
  const manager = new WorktreeManager(root);
  await manager.create({ name: "run-diff", branch: "etnpilot/run-diff" });
  const workspace = join(root, ".etnpilot", "worktrees", "run-diff");
  await writeFile(join(workspace, "README.md"), "# fixture\nsecond line\nthird line\n");
  await writeFile(join(workspace, "new.txt"), "one\ntwo\n");

  const state = await openProjectState({ root });
  try {
    const diff = await state.worktreeDiff("run-diff", "README.md");
    assert.equal(diff.file, "README.md");
    assert.deepEqual({ added: diff.added, deleted: diff.deleted, hunks: diff.hunks }, { added: 2, deleted: 0, hunks: 1 });
    // Every line carries the number it has on its own side.
    const added = diff.lines.filter((line) => line.kind === "add");
    assert.deepEqual(added.map((line) => [line.newLine, line.text]), [[2, "second line"], [3, "third line"]]);
    assert.equal(diff.lines.find((line) => line.kind === "context").oldLine, 1);
    assert.equal(diff.lines[0].kind, "hunk");

    // A file git does not track yet is a diff against nothing.
    const untracked = await state.worktreeDiff("run-diff", "new.txt");
    assert.equal(untracked.added, 2);
    assert.deepEqual(untracked.lines.filter((line) => line.kind === "add").map((line) => line.text), ["one", "two"]);

    // A file this worktree never reported is refused before anything is read.
    await assert.rejects(() => state.worktreeDiff("run-diff", "../../etc/passwd"), TypeError);
    await assert.rejects(() => state.worktreeDiff("run-diff", "README.md.orig"), TypeError);

    const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
    try {
      await app.refresh();
      await app.handle("5");
      await app.handle("g");
      await moveTo(app, app.worktrees.entries.findIndex((entry) => entry.name === "run-diff"));
      await app.handle("\r");
      assert.equal(app.worktreeChanges.entries.length, 2);
      // Enter again, on the file the cursor is on, shows what it changed.
      await app.handle("\r");
      assert.equal(app.worktreeDiff.file, "README.md");
      const screen = stripAnsi(app.frame().join("\n"));
      assert.match(screen, /README\.md\s+\+2 −0 in 1 place/);
      assert.match(screen, /\+second line/);
      assert.match(screen, /↑↓ scroll/);

      // Escape steps back to the files, then out of the worktree.
      await app.handle("\u001B");
      assert.equal(app.worktreeDiff, undefined);
      assert.equal(app.detail, true);
      await app.handle("\u001B");
      assert.equal(app.detail, false);
    } finally {
      app.stop();
    }
  } finally {
    state.close();
  }
});

test("a diff is read as lines, with the number each one has", () => {
  const parsed = parseDiff([
    "diff --git a/x b/x",
    "index 1111111..2222222 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -3,4 +3,5 @@ function head() {",
    " kept",
    "-gone",
    "+added one",
    "+added two",
    " also kept",
    "\\ No newline at end of file",
  ].join("\n"));
  assert.deepEqual({ added: parsed.added, deleted: parsed.deleted, hunks: parsed.hunks }, { added: 2, deleted: 1, hunks: 1 });
  // The header lines are not part of what changed.
  assert.equal(parsed.lines.filter((line) => line.text.startsWith("diff --git")).length, 0);
  assert.deepEqual(parsed.lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ["hunk", undefined, undefined],
    ["context", 3, 3],
    ["remove", 4, undefined],
    ["add", undefined, 4],
    ["add", undefined, 5],
    ["context", 5, 6],
    ["note", undefined, undefined],
  ]);
  // A long diff says it was cut rather than pretending to be whole.
  const long = parseDiff(["@@ -1,1 +1,1 @@", ...Array.from({ length: 50 }, (_, index) => "+line " + index)].join("\n"), { limit: 10 });
  assert.equal(long.cut, true);
  assert.equal(long.lines.length, 10);
});
