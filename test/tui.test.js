import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { displayWidth, duration, pad, since, stripAnsi, truncate } from "../src/tui/ansi.js";
import { clamp, renderApp, window as slidingWindow, wrap } from "../src/tui/render.js";
import { createTuiApp } from "../src/tui/app.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";

test("styled text is measured and cut by what the terminal shows", () => {
  const styled = "\u001B[38;5;111mETNPILOT\u001B[39m";
  assert.equal(displayWidth(styled), 8);
  assert.equal(stripAnsi(styled), "ETNPILOT");

  // Cutting must not leave a colour bleeding into the rest of the line.
  const cut = truncate(styled, 5);
  assert.equal(displayWidth(cut), 5);
  assert.equal(stripAnsi(cut), "ETNP…");
  assert.ok(cut.endsWith("\u001B[39m…"));

  assert.equal(truncate("short", 20), "short");
  assert.equal(truncate("anything", 0), "");
  assert.equal(displayWidth(pad(styled, 14)), 14);

  assert.equal(since(new Date(Date.now() - 90_000).toISOString()), "1m");
  assert.equal(since(new Date(Date.now() - 2000).toISOString()), "now");
  assert.equal(since("not a date"), "—");
  assert.equal(duration(450), "450ms");
  assert.equal(duration(48_123), "48.1s");
  assert.equal(duration(125_000), "2m 5s");
  assert.equal(duration(undefined), "—");
});

test("the frame always fits the terminal it was given", () => {
  const frame = renderApp(sampleState(), { width: 64, height: 18, color: true, now: Date.now() });
  assert.equal(frame.length, 18);
  for (const line of frame) assert.ok(displayWidth(line) <= 64, `too wide: ${JSON.stringify(line)}`);

  // A cramped terminal still produces a frame rather than throwing.
  const tiny = renderApp(sampleState(), { width: 20, height: 6, color: false });
  assert.equal(tiny.length, 6);
  for (const line of tiny) assert.ok(displayWidth(line) <= 20);
});

test("the approvals view shows what is waiting and what the keys do", () => {
  const plain = renderApp(sampleState(), { width: 96, height: 20, color: false }).join("\n");
  assert.match(plain, /2 waiting/);
  assert.match(plain, /SHELL/);
  assert.match(plain, /npm run migrate -- --database production/);
  assert.match(plain, /approve/);
  assert.match(plain, /quit/);

  const empty = renderApp({ approvals: { pending: [] }, queue: { counts: {}, jobs: [] }, runs: [] }, {
    width: 80, height: 12, color: false,
  }).join("\n");
  assert.match(empty, /Nothing is waiting for a decision/);
});

test("the detail view shows the whole command, not a summary", () => {
  const long = "npm run migrate -- --database production --connection postgres://etnpilot@db.internal:5432/app --apply --yes";
  const state = sampleState();
  state.approvals.pending[0].details.command = long;
  const detail = renderApp(state, { width: 60, height: 24, color: false, detail: true, cursor: 0 }).join("\n");

  // Wrapped across lines, but every word of it is present.
  for (const word of ["--database", "production", "postgres://etnpilot@db.internal:5432/app", "--yes"]) {
    assert.ok(detail.includes(word), `missing ${word}`);
  }
  assert.match(detail, /9f56671546f25f04/);
});

test("runs and queue views render their tables", () => {
  const runs = renderApp(sampleState(), { view: "runs", width: 100, height: 16, color: false }).join("\n");
  assert.match(runs, /RUN\s+STATUS/);
  assert.match(runs, /20260923-4f2a9c1b/);
  assert.match(runs, /succeeded/);

  const queue = renderApp(sampleState(), { view: "queue", width: 100, height: 16, color: false }).join("\n");
  assert.match(queue, /queued 2/);
  assert.match(queue, /gitlab-issue/);
});

test("selection helpers keep the cursor on a real row", () => {
  assert.equal(clamp(-4, 3), 0);
  assert.equal(clamp(9, 3), 2);
  assert.equal(clamp(0, 0), 0);
  assert.deepEqual(slidingWindow([1, 2, 3], 0, 5), [1, 2, 3]);
  assert.deepEqual(slidingWindow([1, 2, 3, 4, 5, 6], 5, 3), [4, 5, 6]);
  assert.deepEqual(slidingWindow([1, 2, 3, 4, 5, 6], 0, 3), [1, 2, 3]);
  assert.deepEqual(wrap("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrap("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
});

test("keys move, open, and decide against the real inbox", async () => {
  const { root, inbox } = await createProject();
  const first = inbox.create({ kind: "shell", fullCommandText: "npm run migrate --apply" }, { agent: "builder", runId: "r1" }, { timeoutMs: 60_000 });
  inbox.create({ kind: "write", fileName: "src/index.js" }, { agent: "builder", runId: "r1" }, { timeoutMs: 60_000 });
  inbox.close();

  const state = await openProjectState({ root });
  const output = fakeOutput();
  const app = createTuiApp({ state, output, input: new EventEmitter(), actor: "maintainer" });
  try {
    await app.refresh();
    assert.equal(app.snapshot.approvals.pending.length, 2);

    assert.equal(await app.handle("\u001B[B"), true);
    assert.equal(app.cursor, 1);
    assert.equal(await app.handle("\u001B[A"), true);
    assert.equal(app.cursor, 0);

    await app.handle("\r");
    assert.equal(app.detail, true);
    await app.handle("\u001B");
    assert.equal(app.detail, false);

    await app.handle("\t");
    assert.equal(app.view, "runs");
    await app.handle("1");
    assert.equal(app.view, "approvals");

    // The newest approval is first, so approve the one the cursor is on.
    await app.handle("a");
    assert.equal(state.inbox.get(app.snapshot.approvals.pending[0].id).status, "pending");
    assert.equal(app.snapshot.approvals.pending.length, 1);
    assert.match(app.message, /approved/);

    await app.handle("a");
    assert.equal(state.inbox.get(first.id).status, "approved");
    assert.equal(app.snapshot.approvals.pending.length, 0);

    assert.equal(await app.handle("q"), false);
  } finally {
    app.stop();
    state.close();
  }
});

test("a decision made elsewhere is reported, not overwritten", async () => {
  const { root, inbox } = await createProject();
  const approval = inbox.create({ kind: "shell", fullCommandText: "rm -rf build" }, { agent: "builder" }, { timeoutMs: 60_000 });
  inbox.close();

  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    // Somebody answers from the CLI while the TUI is showing it.
    state.inbox.decide(approval.id, "rejected", { actor: "cli:maintainer" });

    await app.handle("a");
    assert.match(app.message, /already rejected/);
    assert.equal(state.inbox.get(approval.id).decidedBy, "cli:maintainer");
  } finally {
    app.stop();
    state.close();
  }
});

function fakeOutput() {
  const output = new EventEmitter();
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  output.written = [];
  output.write = (text) => output.written.push(text);
  return output;
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const store = new JsonlReceiptStore(join(root, ".etnpilot", "state", "runs", "20260923071500-4f2a9c1b.jsonl"));
  await store.append({ type: "workflow", terminal: true, runId: "20260923-4f2a9c1b", status: "succeeded", durationMs: 48_123 });
  return { root, inbox: new ApprovalInbox(join(root, ".etnpilot", "state", "approvals.sqlite")) };
}

function sampleState() {
  const iso = (offset) => new Date(Date.now() - offset).toISOString();
  return {
    approvals: {
      pending: [
        {
          id: "a1", operationKind: "shell", agent: "builder", runId: "20260923-4f2a9c1b",
          createdAt: iso(240_000), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          details: { command: "npm run migrate -- --database production --apply --yes", fingerprint: "9f56671546f25f04" },
        },
        {
          id: "a2", operationKind: "write", agent: "builder", runId: "20260923-4f2a9c1b",
          createdAt: iso(720_000), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          details: { file: "src/gitlab/webhook-server.js", fingerprint: "c2aae2e83f0e175d" },
        },
      ],
      recent: [],
    },
    queue: {
      counts: { queued: 2, running: 1 },
      jobs: [
        { id: "d71151cd-aaaa", kind: "gitlab-issue", status: "running", attempts: 1, updatedAt: iso(30_000) },
        { id: "c5c7c728-bbbb", kind: "gitlab-issue", status: "queued", attempts: 0, updatedAt: iso(60_000) },
      ],
    },
    runs: [
      { runId: "20260923-4f2a9c1b", status: "succeeded", mode: "execute", terminal: true, signed: true, approvals: 2, durationMs: 48_123 },
      { runId: "20260923-9b3e7d20", status: "failed", mode: "execute", terminal: true, signed: false, approvals: 1, durationMs: 12_400 },
    ],
  };
}

test("the detail view names the rule that stopped the operation", async () => {
  const { root, inbox } = await createProject();
  // The harness passes the policy decision into the handler's context.
  inbox.create({ kind: "shell", fullCommandText: "npm test" }, {
    agent: "builder",
    runId: "20260923-4f2a9c1b",
    policy: { section: "operations", effect: "human", rule: "shell-with-review" },
  }, { timeoutMs: 60_000 });
  inbox.close();

  const state = await openProjectState({ root });
  try {
    const snapshot = await state.collect();
    assert.deepEqual(snapshot.approvals.pending[0].policy, {
      section: "operations", effect: "human", rule: "shell-with-review",
    });
    const detail = renderApp(snapshot, { width: 80, height: 24, color: false, detail: true }).join("\n");
    assert.match(detail, /Why you are being asked/);
    assert.match(detail, /human .*rule 'shell-with-review'/);
    // A run id is identified by its tail, not by the date every run shares.
    assert.match(renderApp(snapshot, { width: 80, height: 16, color: false }).join("\n"), /4f2a9c1b/);
  } finally {
    state.close();
  }
});

test("the harness tells the approval handler why it is asking", async () => {
  const { Harness } = await import("../src/core/harness.js");
  const { ApprovalPolicy } = await import("../src/core/approval-policy.js");
  const { PolicyEngine } = await import("../src/policy/engine.js");

  const seen = [];
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy({}, {
      policy: new PolicyEngine({
        operations: { default: "deny", rules: [{ id: "shell-with-review", effect: "human", kinds: ["shell"] }] },
      }),
    }),
    approvalHandler: async (request, context) => {
      seen.push(context.policy);
      return { kind: "approve-once" };
    },
  });

  const decision = await harness.approveOperation({ kind: "shell", fullCommandText: "npm test" }, { agent: "builder" });
  assert.equal(decision.kind, "approve-once");
  assert.deepEqual(seen, [{ section: "operations", effect: "human", rule: "shell-with-review" }]);
});
