import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { createReviewServer } from "../src/ui/server.js";

// A run started from the page asks the page that started it: the requests land
// in the same inbox the screen is already showing, so nobody has to open a
// second window to answer their own run.
test("a run is started from the page, answered on the page, and ends in a receipt", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  const asked = [];
  withFakeProvider(review, asked);
  try {
    const call = await caller(review);
    const started = await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "Add a health check" }) });
    // The page is answered at once rather than held for the whole run.
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { started: true, task: "Add a health check" });

    const working = await (await call("/api/state")).json();
    assert.equal(working.active.length, 1, "the state says what is running");
    assert.equal(working.active[0].task, "Add a health check");

    const state = await waitFor(call, (payload) => payload.approvals.pending.length === 1, "the approval to arrive");
    const approval = state.approvals.pending[0];
    assert.equal(approval.details.command, "npm run build");

    const decided = await (await call("/api/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ id: approval.id, decision: "approve", actor: "maintainer" }),
    })).json();
    assert.equal(decided.status, "approved");

    const finished = await waitFor(call, (payload) => payload.runs.length === 1 && payload.active.length === 0, "the run to finish");
    assert.equal(finished.runs[0].status, "succeeded");
    assert.deepEqual(finished.recentRunErrors, []);
    assert.equal(asked[0].kind, "approve-once");
    // The decision is attributed to whoever was at this page.
    assert.equal(asked[0].evidence.decidedBy, "ui:maintainer");

    // And the receipt it sealed is readable from the page it was started on.
    const receipt = await (await call(`/api/runs/${encodeURIComponent(finished.runs[0].receiptFile)}`)).json();
    assert.equal(receipt.terminal.status, "succeeded");
  } finally {
    await review.close();
  }
});

test("a run needs a task, and a failure is reported rather than lost", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => start({
    ...options,
    providerFactories: { fake: (name) => ({ name, invoke: () => { throw new Error("the provider gave up"); } }) },
  });
  try {
    const call = await caller(review);
    for (const body of [{}, { task: "   " }]) {
      const response = await call("/api/runs/start", { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /needs a task/);
    }

    await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "break please" }) });
    // Nobody is awaiting this run, so the page is where its failure surfaces.
    const state = await waitFor(call, (payload) => payload.recentRunErrors.length === 1, "the failure to be reported");
    assert.equal(state.recentRunErrors[0].task, "break please");
    assert.match(state.recentRunErrors[0].error, /gave up/);
    assert.equal(state.active.length, 0);
  } finally {
    await review.close();
  }
});

test("closing the page's server stops the run it started", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  let settled;
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => {
    settled = start({
      ...options,
      // Never answers on its own: only the abort can end this run.
      providerFactories: { fake: (name) => ({ name, invoke: (context) => context.approve({ kind: "shell", fullCommandText: "sleep" }) }) },
    });
    return settled;
  };
  const call = await caller(review);
  await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "wait for me" }) });
  await waitFor(call, (payload) => payload.approvals.pending.length === 1, "the approval to arrive");

  await review.close();
  // The run settles rather than hanging, and its waiting request is closed by
  // the service instead of being left pending for nobody — as quitting the TUI
  // does, because both go through the same state.
  await settled.then(() => undefined, (error) => assert.match(error.message, /abort/i));
  const { ApprovalInbox } = await import("../src/core/approval-inbox.js");
  const inbox = new ApprovalInbox(join(root, ".etnpilot", "state", "approvals.sqlite"));
  try {
    assert.equal(inbox.list({ status: "pending" }).length, 0);
    assert.match(inbox.list({ status: "rejected" })[0].reason, /shutting down/);
  } finally {
    inbox.close();
  }
});

// ------------------------------------------------------------------ fixtures

function withFakeProvider(review, asked) {
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => start({
    ...options,
    providerFactories: {
      fake: (name) => ({
        name,
        async invoke(context) {
          const decision = await context.approve({ kind: "shell", fullCommandText: "npm run build" });
          asked.push(decision);
          return { text: decision.kind };
        },
      }),
    },
  });
}

async function caller(review) {
  const address = await review.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  return (path, options = {}) => fetch(base + path, {
    ...options,
    headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
}

async function waitFor(call, predicate, what, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await (await call("/api/state")).json();
    if (predicate(payload)) return payload;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

async function runnableProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-run-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do the work.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "content:",
    "  provenance:",
    "    mode: off",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    "approval:",
    "  inbox:",
    "    enabled: true",
    "    pollIntervalMs: 20",
    "workflow:",
    "  steps:",
    "    - id: build",
    "      type: agent",
    "      agent: worker",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}

test("a run that failed says why, with its steps, and what it cost", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => start({
    ...options,
    providerFactories: {
      fake: (name) => ({ name, invoke: () => { throw new Error("the provider gave up"); } }),
    },
  });
  try {
    const call = await caller(review);
    await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "break please" }) });
    const state = await waitFor(call, (payload) => payload.runs.length === 1, "the run to be recorded");
    const run = state.runs[0];
    assert.equal(run.status, "failed");

    const receipt = await (await call(`/api/runs/${encodeURIComponent(run.receiptFile)}`)).json();
    // The reason is the failing step's own error, not 'it failed'.
    const failure = receipt.outcome.reasons.find((reason) => reason.kind === "step");
    assert.equal(failure.step, "build");
    assert.match(failure.text, /gave up/);
    assert.equal(receipt.outcome.status, "failed");
    assert.equal(receipt.outcome.steps.find((step) => step.id === "build").status, "failed");
  } finally {
    await review.close();
  }
});

test("a run in progress says which step it is in, and which agent", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  const asked = [];
  withFakeProvider(review, asked);
  try {
    const call = await caller(review);
    await call("/api/runs/start", { method: "POST", body: JSON.stringify({ task: "watch me" }) });
    // While it waits for its approval, the state says where it is.
    const working = await waitFor(call, (payload) => payload.active[0]?.step !== undefined, "the step to start");
    const [run] = working.active;
    assert.equal(run.step, "build");
    assert.equal(run.stepAgent, "worker");
    assert.deepEqual(run.steps, ["build"]);
    assert.equal(run.done, 0);
    assert.ok(Date.parse(run.stepSince) > 0);

    const pending = working.approvals.pending[0] ?? (await waitFor(call, (payload) => payload.approvals.pending.length === 1, "the approval")).approvals.pending[0];
    await call("/api/approvals/decide", { method: "POST", body: JSON.stringify({ id: pending.id, decision: "approve" }) });
    await waitFor(call, (payload) => payload.active.length === 0, "the run to finish");
  } finally {
    await review.close();
  }
});

test("usage is served, and says why there is none when nothing records it", async () => {
  const root = await runnableProject();
  const review = await createReviewServer({ root });
  try {
    const call = await caller(review);
    const usage = await (await call("/api/usage")).json();
    // This project has observability off, so the answer names that rather
    // than showing a zero that looks like a measurement.
    assert.equal(usage.available, false);
    assert.match(usage.reason, /observability\.enabled is false/);
  } finally {
    await review.close();
  }
});
