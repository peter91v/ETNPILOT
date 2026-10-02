import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git/command.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { createTuiApp } from "../src/tui/app.js";
import { createReviewServer } from "../src/ui/server.js";
import { renderReviewPage } from "../src/ui/page.js";
import { waitFor } from "./helpers/wait.js";

// A run that is still working can be stopped on its own: the others go on, a
// pending approval is rejected as "stopped" (not as a shutdown), and the
// receipt is sealed as failed.

async function project({ gate = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-stop-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake",
    "content:", "  provenance:", "    mode: off", "codegraph:", "  enabled: false", "observability:", "  enabled: false",
    "approval:", "  inbox:", "    enabled: true", "    pollIntervalMs: 20",
    "workflow:", "  steps:", "    - id: first", "      type: agent", "      agent: worker",
    ...(gate ? ["    - id: approve", "      type: gate", "      needs: [first]", "      questions: false"] : []), "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  return root;
}

// A provider that works until it is told to stop.
const hanging = {
  fake: (name) => ({
    name,
    invoke: ({ signal }) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    }),
  }),
};

async function sealed(root) {
  const runs = join(root, ".etnpilot", "state", "runs");
  const [file] = (await readdir(runs)).filter((name) => name.endsWith(".jsonl"));
  const entries = (await readFile(join(runs, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return entries.at(-1);
}

test("stopping a run that is working ends it, sealed as failed, with the reason in its receipt", async () => {
  const root = await project();
  const state = await openProjectState({ root });
  try {
    const started = state.startRun({ input: "work", providerFactories: hanging });
    started.catch(() => {});
    await waitFor(() => state.active.some((run) => run.runId !== undefined), "the run to be planned");
    const [run] = state.active;
    assert.ok(run.id, "a working run has an id the screen can name");
    assert.deepEqual(state.stopRun(run.id), { stopped: true, id: run.id, task: "work" });
    await waitFor(() => state.active.length === 0, "the run to end");
    const last = await sealed(root);
    assert.equal(last.terminal, true);
    assert.equal(last.status, "failed");
    assert.match(JSON.stringify(last.summary), /The run was stopped/);
    assert.throws(() => state.stopRun(run.id), /not running here/);
  } finally {
    state.close();
  }
});

test("a run that waits for an approval is stopped, and the approval is rejected as stopped", async () => {
  const root = await project({ gate: true });
  const state = await openProjectState({ root });
  try {
    const quick = { fake: (name) => ({ name, invoke: async () => ({ text: "a plan" }) }) };
    const started = state.startRun({ input: "work", providerFactories: quick });
    started.catch(() => {});
    await waitFor(async () => (await state.collect()).approvals.pending.length === 1, "the gate to ask");
    state.stopRun(state.active[0].id);
    await waitFor(() => state.active.length === 0, "the run to end");
    const collected = await state.collect();
    assert.equal(collected.approvals.pending.length, 0);
    const [decided] = collected.approvals.recent;
    assert.equal(decided.status, "rejected");
    assert.match(decided.reason, /The run was stopped/);
    assert.doesNotMatch(decided.reason, /shutting down/);
  } finally {
    state.close();
  }
});

test("over HTTP: an unknown run is a 404, a working one is stopped", async () => {
  const root = await project();
  const review = await createReviewServer({ root });
  const address = await review.listen({ port: 0 });
  try {
    const call = (path, body) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "x-etnpilot-token": review.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await call("/api/runs/stop", { id: "nope" })).status, 404);
    assert.equal((await call("/api/runs/stop", {})).status, 400);
    review.state.startRun({ input: "work", providerFactories: hanging }).catch(() => {});
    await waitFor(() => review.state.active.length === 1, "the run to start");
    const response = await call("/api/runs/stop", { id: review.state.active[0].id });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stopped, true);
    await waitFor(() => review.state.active.length === 0, "the run to end");
  } finally {
    await review.close();
  }
});

test("the page offers the button on a working run", () => {
  assert.match(renderReviewPage("t"), /Stop run/);
  assert.match(renderReviewPage("t"), /\/api\/runs\/stop/);
});

test("in the TUI 'x' stops the run whose detail is open, and only a run that is working", async () => {
  const root = await project();
  const state = await openProjectState({ root });
  const output = { columns: 100, rows: 40, isTTY: false, write() {}, on() {}, off() {} };
  const app = createTuiApp({ state, output, input: new EventEmitter() });
  try {
    state.startRun({ input: "work", providerFactories: hanging }).catch(() => {});
    await waitFor(() => state.active.some((run) => run.runId !== undefined), "the run to be planned");
    // Its receipt is only started once the run is set up, so the list may not have it yet.
    await waitFor(async () => (await state.collect()).runs.some((run) => run.runId === state.active[0]?.runId), "the run to appear in the list");
    await app.refresh();
    await app.handle("2");
    await app.handle("\r");
    assert.equal(app.detail, true);
    assert.match(stripAnsi(app.frame().at(-1)), /x stop run/);
    await app.handle("x");
    await waitFor(() => state.active.length === 0, "the run to end");
    await app.refresh();
    assert.equal(app.active.length, 0);
    // Once it is over there is nothing to stop: the hint is gone and `x` does nothing.
    assert.doesNotMatch(stripAnsi(app.frame().at(-1)), /x stop run/);
  } finally {
    app.stop();
    state.close();
  }
});
