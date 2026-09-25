import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { renderApp } from "../src/tui/render.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { createTuiApp } from "../src/tui/app.js";

function fakeOutput() {
  return { columns: 100, rows: 24, isTTY: false, write() {}, on() {}, off() {} };
}

async function type(app, text) {
  for (const key of text) await app.handle(key);
}

function screen(app) {
  return stripAnsi(app.frame().join("\n"));
}

async function waitFor(condition, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

// A project with one agent whose provider asks for one approval, so a run
// started here has to come back through the screen that started it.
async function runnableProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-run-"));
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

test("a run started from the TUI asks the screen that started it", async () => {
  const root = await runnableProject();
  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter(), actor: "peter" });
  const asked = [];

  // The app does not pass providers; the test does, so the run is offline.
  const start = state.startRun.bind(state);
  state.startRun = (options) => start({
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

  try {
    await app.refresh();
    await app.handle("n");
    assert.equal(app.prompt.field, "task");
    await type(app, "Add a health check");
    await app.handle("\r");

    assert.equal(app.prompt, undefined);
    assert.equal(app.active.length, 1, "the run is tracked while it works");
    assert.match(app.message, /Started: Add a health check/);
    // The header counts it, so a run you are watching is visible as running.
    assert.match(screen(app), /1 running/);

    // The run's own approval arrives in this window's inbox.
    await waitFor(async () => (await app.refresh()).approvals.pending.length === 1, "the approval to arrive");
    assert.equal(app.view, "approvals");
    assert.match(screen(app), /npm run build/);

    await app.handle("a");
    assert.match(app.message, /shell approved/);

    await waitFor(async () => app.active.length === 0, "the run to finish");
    assert.equal(asked[0].kind, "approve-once");
    // The decision is attributed to whoever was at this terminal.
    assert.equal(asked[0].evidence.decidedBy, "tui:peter");

    await app.refresh();
    assert.equal(app.snapshot.runs.length, 1);
    assert.equal(app.snapshot.runs[0].status, "succeeded");
  } finally {
    app.stop();
    state.close();
  }
});

test("a run needs a task, and an empty agent field says what would run instead", async () => {
  const root = await runnableProject();
  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter(), actor: "peter" });
  try {
    await app.refresh();
    await app.handle("n");

    // The task is typed on the bottom line, and whatever was on screen stays
    // there — that is the point of typing down here. The line above says what
    // an empty agent field would run, so it is never just a blank.
    assert.deepEqual(app.prompt.steps, ["build"]);
    const typing = app.frame().map(stripAnsi);
    assert.match(typing.at(-1), /^run> {2}$/);
    assert.match(typing.at(-2), /agent: the project's workflow: build · tab to name one/);
    assert.match(typing.join("\n"), /Nothing is waiting for a decision/);

    await app.handle("\r");
    assert.match(app.prompt.error, /A run needs a task to work on/);
    // The refusal replaces the hint, right above the line it was typed on.
    assert.match(app.frame().map(stripAnsi).at(-2), /^A run needs a task to work on\.$/);
    assert.equal(app.active.length, 0);

    await app.handle("\t");
    assert.equal(app.prompt.field, "agent");
    await app.handle("\u001B");
    assert.equal(app.prompt, undefined);
  } finally {
    app.stop();
    state.close();
  }
});

test("naming an agent runs that agent, even where the project defines a workflow", async () => {
  const root = await runnableProject();
  const state = await openProjectState({ root });
  const ran = [];
  const start = state.startRun.bind(state);
  state.startRun = (options) => start({
    ...options,
    providerFactories: {
      fake: (name) => ({
        name,
        invoke(context) {
          ran.push(context.agent.name);
          return { text: "done" };
        },
      }),
    },
  });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter(), actor: "peter" });
  try {
    await app.refresh();

    // An agent this project does not define is reported, not ignored.
    await app.handle("n");
    await type(app, "do something");
    await app.handle("\t");
    await type(app, "nobody");
    await app.handle("\r");
    await waitFor(async () => /The run failed/.test(app.message ?? ""), "the unknown agent to be reported");
    assert.match(app.message, /Unknown workflow agent: 'nobody'/);
    assert.deepEqual(ran, []);

    // A named agent replaces the configured steps rather than being dropped.
    await app.handle("n");
    await type(app, "do it with the worker");
    await app.handle("\t");
    await type(app, "worker");
    await app.handle("\r");
    await waitFor(async () => app.active.length === 0, "the run to finish");
    assert.deepEqual(ran, ["worker"]);
  } finally {
    app.stop();
    state.close();
  }
});

test("quitting stops a run rather than stranding it", async () => {
  const root = await runnableProject();
  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter(), actor: "peter" });
  const start = state.startRun.bind(state);
  let settled;
  state.startRun = (options) => {
    settled = start({
      ...options,
      providerFactories: {
        // Never answers on its own: only the abort can end this run.
        fake: (name) => ({ name, invoke: (context) => context.approve({ kind: "shell", fullCommandText: "sleep" }) }),
      },
    });
    return settled;
  };

  try {
    await app.refresh();
    await app.handle("n");
    await type(app, "wait for me");
    await app.handle("\r");
    await waitFor(async () => (await app.refresh()).approvals.pending.length === 1, "the approval to arrive");

    app.stop();
    // The run settles rather than hanging, and its waiting request is closed
    // by the service instead of being left pending for nobody.
    await settled.then(() => undefined, (error) => assert.match(error.message, /abort/i));
    assert.equal(state.inbox.list({ status: "pending" }).length, 0);
    const [decided] = state.inbox.list({ status: "rejected" });
    assert.match(decided.reason, /shutting down/);
  } finally {
    state.close();
  }
});

test("enter on a run opens its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-receipt-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const store = new JsonlReceiptStore(join(root, ".etnpilot", "state", "runs", "20260923071500-4f2a9c1b.jsonl"));
  await store.append({ runId: "r1", approvals: [{ operationKind: "shell", decision: "approve-once", evidence: { decidedBy: "tui:peter" } }] });
  await store.append({
    type: "workflow", terminal: true, runId: "20260923-4f2a9c1b", status: "succeeded", mode: "execute", durationMs: 48_123,
    workspace: { branch: "etnpilot/run-4f2a9c1b" },
    git: { mergeRehearsal: { clean: false, targetBranch: "main", conflicts: ["src/index.js"] } },
    settings: { layers: [{ source: "project", sha256: "a" }, { source: "user-local", sha256: "b" }], overrides: ["queue.workers"] },
  });

  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("2");
    await app.handle("\r");
    assert.equal(app.detail, true);
    const text = screen(app);
    assert.match(text, /etnpilot\/run-4f2a9c1b/);
    assert.match(text, /conflicts with main: src\/index\.js/);
    // Which settings were in effect is evidence, so the run carries it.
    assert.match(text, /project → user-local/);
    assert.match(text, /1 changed locally\s+queue\.workers/);
    assert.match(text, /SHELL\s+approve-once\s+tui:peter/);
    assert.match(text, /esc back/);

    await app.handle("\u001B");
    assert.equal(app.detail, false);
  } finally {
    app.stop();
    state.close();
  }
});

test("help names only keys that do something, and never cuts silently", () => {
  // A roomy terminal shows every key at once.
  const roomy = renderApp({}, { width: 90, height: 24, color: false, help: true });
  const body = roomy.slice(2, -1).join("\n");
  for (const label of ["start a run", "open the receipt", "resume a failed job", "filter"]) {
    assert.match(body, new RegExp(label), `'${label}' is missing`);
  }
  assert.match(roomy.at(-1), /\? close/);

  // A cramped one scrolls, and says so rather than dropping the rest.
  const cramped = renderApp({}, { width: 90, height: 14, color: false, help: true });
  assert.equal(cramped.length, 14);
  assert.match(cramped.slice(2, -1).join("\n"), /↑↓ scroll · \d+ more lines/);

  const scrolled = renderApp({}, { width: 90, height: 14, color: false, help: true, helpOffset: 99 });
  assert.match(scrolled.slice(2, -1).join("\n"), /↑↓ scroll · the end/);
  assert.match(scrolled.slice(2, -1).join("\n"), /filter/);
  assert.match(scrolled.at(-1), /↑↓ scroll/);
});

test("a receipt file outside this project's runs is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-escape-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const state = await openProjectState({ root });
  try {
    await assert.rejects(state.readReceipt("../../etc/passwd"), /not a receipt file in this project/);
    await assert.rejects(state.readReceipt("notes.txt"), /not a receipt file in this project/);
  } finally {
    state.close();
  }
});

test("the agents in a run are a navigable tree, and 'a' then enter reads one's full text", async () => {
  // What was asked: see the agents that worked hierarchically, and open each
  // one to read its full reasoning. The receipt already holds it, untruncated
  // — this only has to be reachable.
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-agents-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const store = new JsonlReceiptStore(join(root, ".etnpilot", "state", "runs", "20260924160000-tree01.jsonl"));
  await store.append({
    runId: "agent-plan", agent: "orchestrator", workflowStep: "plan", provider: "openai",
    status: "succeeded", durationMs: 21_800, approvals: [],
    result: { text: "1. Read README\n2. Delegate the write to the builder.", toolCalls: [] },
  });
  await store.append({
    runId: "agent-build", agent: "builder", workflowStep: "build", provider: "openai",
    status: "succeeded", durationMs: 9_600, approvals: [],
    result: { text: "Wrote CHANGES.md.", toolCalls: [{ tool: "write_file", ok: true }] },
  });
  // A subagent the builder spawned: nested under it by parentRunId, not
  // listed as its own workflow step.
  await store.append({
    runId: "agent-build-lint", parentRunId: "agent-build", agent: "linter", provider: "openai",
    status: "failed", durationMs: 1_400, approvals: [],
    error: "lint failed: unexpected token at line 12",
    result: { text: "", toolCalls: [{ tool: "run_command", ok: false, error: "exit code 2" }] },
  });
  await store.append({
    type: "workflow", terminal: true, runId: "20260924160000-tree01", status: "succeeded", mode: "execute",
    durationMs: 40_800, workspace: { branch: "etnpilot/run-tree01" },
    summary: { status: "succeeded", steps: { plan: { status: "succeeded" }, build: { status: "succeeded" } } },
  });

  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("2"); // switch to the runs view
    await app.handle("\r"); // open the run
    await waitFor(() => screen(app).includes("Agents"), "the receipt to load");

    // Collapsed: one row per invocation, the subagent indented under its
    // parent rather than listed as a sibling.
    const collapsed = screen(app);
    assert.match(collapsed, /Agents — press 'a'/);
    assert.match(collapsed, /plan · orchestrator/);
    assert.match(collapsed, /^ {4}failed\s+linter/m, "the subagent is indented under its parent, not listed beside it");
    assert.equal(app.agentMode, false);

    await app.handle("a");
    assert.equal(app.agentMode, true);
    const inMode = screen(app);
    assert.match(inMode, /Agents — ↑↓ move, enter to read/);
    assert.match(inMode, /›.*plan · orchestrator/, "the cursor starts on the first row");

    // Down twice: plan -> build -> linter.
    await app.handle("\u001B[B");
    await app.handle("\u001B[B");
    assert.match(screen(app), /›.*failed\s+linter/);

    await app.handle("\r");
    const opened = screen(app);
    assert.match(opened, /linter failed openai · 1\.4s/);
    assert.match(opened, /lint failed: unexpected token at line 12/);
    assert.match(opened, /refused\s+run_command\s+exit code 2/);
    assert.equal(app.agentText.agent, "linter");

    // Esc backs out one layer at a time: text, then agent mode, then the run.
    await app.handle("\u001B");
    assert.equal(app.agentText, undefined);
    assert.equal(app.agentMode, true);
    await app.handle("\u001B");
    assert.equal(app.agentMode, false);
    assert.equal(app.detail, true);
    await app.handle("\u001B");
    assert.equal(app.detail, false);
  } finally {
    state.close();
  }
});

test("'v' says whether the receipt on screen verifies, and a tampered one does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-verify-"));
  const runs = join(root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const file = "20260924170000-verify1.jsonl";
  const store = new JsonlReceiptStore(join(runs, file));
  await store.append({ runId: "verify-1", agent: "orchestrator", status: "succeeded", approvals: [] });
  await store.append({ runId: "verify-1", terminal: true, status: "succeeded", approvals: [] });

  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("2");
    await app.handle("\r");
    // Until it is asked for, the panel offers the key rather than claiming
    // either answer: 'not checked' and 'checked, and sound' are not the same.
    let frame = stripAnsi(app.frame().join("\n"));
    assert.match(frame, /press 'v' to check its hash chain/);
    assert.equal(/verified/.test(frame), false);

    await app.handle("v");
    assert.equal(app.verification.valid, true);
    frame = stripAnsi(app.frame().join("\n"));
    assert.match(frame, /verified/);
    assert.match(frame, /The chain holds: 2 entries/);
    // No public key is configured here, so the signatures were not checked —
    // and the line says that instead of letting 'verified' cover both.
    assert.match(frame, /Signatures were not checked/);
    assert.equal(app.verification.signaturesChecked, false);
  } finally {
    app.stop();
    state.close();
  }

  // Change one byte of a sealed record and the same key says so, naming the
  // line and what kind of change it was.
  const lines = (await readFile(join(runs, file), "utf8")).split("\n").filter(Boolean);
  const entry = JSON.parse(lines[0]);
  entry.agent = "somebody-else";
  lines[0] = JSON.stringify(entry);
  await writeFile(join(runs, file), `${lines.join("\n")}\n`);

  const tampered = await openProjectState({ root });
  const second = createTuiApp({ state: tampered, output: fakeOutput(), input: new EventEmitter() });
  try {
    await second.refresh();
    await second.handle("2");
    await second.handle("\r");
    await second.handle("v");
    assert.equal(second.verification.valid, false);
    assert.equal(second.verification.reason, "hash-mismatch");
    const frame = stripAnsi(second.frame().join("\n"));
    assert.match(frame, /DOES NOT VERIFY/);
    assert.match(frame, /does not match its own hash at line 1/);
    assert.match(frame, /changed after it was written/);
  } finally {
    second.stop();
    tampered.close();
  }
});

test("a receipt name from a surface cannot reach outside the runs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-verify-escape-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const state = await openProjectState({ root });
  try {
    // The same guard reading applies, because it is the same class of input.
    await assert.rejects(state.verifyReceipt("../../etc/passwd"), /not a receipt file in this project/);
    await assert.rejects(state.verifyReceipt("notes.txt"), /not a receipt file in this project/);
    // A name that is shaped right but is not there reads as unreadable, not
    // as a receipt that failed to verify for some other reason.
    const missing = await state.verifyReceipt("20260101000000-nope.jsonl");
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, "file-read-failed");
    assert.match(missing.text, /could not be read/);
  } finally {
    state.close();
  }
});
