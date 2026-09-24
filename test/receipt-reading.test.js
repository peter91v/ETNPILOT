import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReceipt, readRuns } from "../src/runtime/project-state.js";

// A run that stopped before it could seal leaves an ordinary entry on the last
// line. Reading that line as the terminal record reports a step's success as
// the run's, and the last entry's chain hash as the receipt's.

const SEALED = [
  { runId: "20260101000000-aaaa", type: "start", mode: "execute" },
  { runId: "20260101000000-aaaa", step: "agent", status: "succeeded", hash: "entry-hash-1" },
  {
    runId: "20260101000000-aaaa",
    terminal: true,
    status: "failed",
    mode: "execute",
    durationMs: 4200,
    hash: "receipt-hash",
    summary: { status: "failed", steps: { agent: { status: "succeeded" }, test: { status: "failed", error: "Check failed" } } },
  },
];

const UNSEALED = [
  // The agent's own id, not the run's: a receipt carries both.
  { runId: "1d0f6b1e-0000-4000-8000-00000000aaaa", type: "start", mode: "execute" },
  // The last thing it managed to write: one step, which succeeded.
  { runId: "1d0f6b1e-0000-4000-8000-00000000aaaa", step: "agent", status: "succeeded", hash: "entry-hash-9", durationMs: 12 },
];

async function runsDirectory(files) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipts-"));
  const directory = join(root, "runs");
  await mkdir(directory, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(join(directory, name), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  }
  return directory;
}

test("an unsealed receipt is not reported as a run that succeeded", async () => {
  const directory = await runsDirectory({
    "20260101000000-aaaa.jsonl": SEALED,
    "20260101000001-bbbb.jsonl": UNSEALED,
  });
  const runs = await readRuns(directory);
  const byId = Object.fromEntries(runs.map((run) => [run.runId, run]));

  const sealed = byId["20260101000000-aaaa"];
  assert.equal(sealed.status, "failed");
  assert.equal(sealed.terminal, true);
  assert.equal(sealed.hash, "receipt-hash");
  assert.equal(sealed.durationMs, 4200);

  const unsealed = byId["20260101000001-bbbb"];
  // Its last entry says 'succeeded'; that is the step's word, not the run's.
  assert.equal(unsealed.status, "incomplete");
  assert.equal(unsealed.terminal, false);
  assert.equal(unsealed.hash, undefined, "an unsealed receipt has no hash of its own");
  assert.equal(unsealed.durationMs, undefined);
  // Each agent invocation writes an id of its own; the run's id is the one
  // every surface names, and the one the file is called.
  assert.equal(unsealed.runId, "20260101000001-bbbb", "the run's id, not an agent's");
});

test("the receipt reader and the run list agree about the same file", async () => {
  const directory = await runsDirectory({ "20260101000001-bbbb.jsonl": UNSEALED });
  const [run] = await readRuns(directory);
  const receipt = await readReceipt(directory, "20260101000001-bbbb.jsonl");

  assert.equal(receipt.terminal, undefined);
  assert.equal(receipt.outcome.sealed, false);
  // One answer about one run: a list saying 'succeeded' beside a panel saying
  // 'never sealed' is two surfaces disagreeing about the same file.
  assert.equal(receipt.outcome.status, run.status);
  assert.equal(
    receipt.outcome.reasons.some((reason) => reason.kind === "incomplete"),
    true,
    "and it says why",
  );
});

test("a sealed receipt still reports its own outcome", async () => {
  const directory = await runsDirectory({ "20260101000000-aaaa.jsonl": SEALED });
  const receipt = await readReceipt(directory, "20260101000000-aaaa.jsonl");
  assert.equal(receipt.outcome.sealed, true);
  assert.equal(receipt.outcome.status, "failed");
  assert.equal(receipt.outcome.reasons.some((reason) => reason.kind === "incomplete"), false);
  assert.equal(receipt.outcome.steps.find((step) => step.id === "test").error, "Check failed");
});

test("'receipt show' gives the terminal the answer the other surfaces give", async () => {
  // Four windows on the same thing: a run explained on the review page and in
  // the terminal interface, but not on the command line, is a surface that
  // cannot do what the others can.
  const { runCli } = await import("../src/cli/commands.js");
  const { initializeProject } = await import("../src/config/init.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-show-"));
  await initializeProject(root);
  const directory = join(root, ".etnpilot", "state", "runs");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "20260101000000-aaaa.jsonl"),
    SEALED.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(directory, "20260101000001-bbbb.jsonl"),
    UNSEALED.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );

  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(line);
  try {
    // With no file it takes the newest run, which is what someone asking
    // 'why did that fail' means.
    const code = await runCli(["receipt", "show"], { root });
    assert.equal(code, 1, "a run that did not succeed exits non-zero");
    const newest = JSON.parse(printed.at(-1));
    assert.equal(newest.receipt, "20260101000001-bbbb.jsonl");
    assert.equal(newest.status, "incomplete");
    assert.equal(newest.sealed, false);
    assert.match(newest.why.join(""), /^the receipt has no terminal record/);

    await runCli(["receipt", "show", "20260101000000-aaaa.jsonl"], { root });
    const named = JSON.parse(printed.at(-1));
    assert.equal(named.status, "failed");
    assert.match(named.why.join("\n"), /test: Check failed/);
    assert.deepEqual(named.steps, [
      { id: "agent", status: "succeeded" },
      { id: "test", status: "failed", error: "Check failed" },
    ]);
    // The whole step payload belongs in the file, not in an answer read on a
    // phone.
    assert.equal("result" in named.steps[0], false);

    // A pasted path is read as this project's own run, never as a way out of
    // the runs directory.
    await assert.rejects(
      () => runCli(["receipt", "show", "../../../etc/passwd.jsonl"], { root }),
      /No receipt named 'passwd\.jsonl' in \.etnpilot\/state\/runs/,
    );
    await assert.rejects(() => runCli(["receipt", "show", "not-a-receipt.txt"], { root }), /is not a receipt file/);
    // The full path 'etnpilot run' prints is accepted as the name it ends in.
    await runCli(["receipt", "show", join(directory, "20260101000000-aaaa.jsonl")], { root });
    assert.equal(JSON.parse(printed.at(-1)).receipt, "20260101000000-aaaa.jsonl");
  } finally {
    console.log = log;
  }
});

test("a run that is still going is not a run that stopped", async () => {
  // What was reported: a row read 'incomplete' at 13:20 and 'succeeded' at
  // 13:21, with nobody touching anything. The receipt had simply not been
  // sealed yet. A surface that says 'the run stopped before it could finish'
  // about a run it is running right now is inventing what it cannot see.
  const { collectState } = await import("../src/runtime/project-state.js");
  const directory = await runsDirectory({ "20260101000001-bbbb.jsonl": UNSEALED });
  const inbox = { list: () => [], close() {} };
  const queue = { counts: () => ({}), list: () => [], close() {} };
  const running = new Set([{ runId: "20260101000001-bbbb", task: "t", startedAt: "now", done: 0 }]);

  const live = await collectState({ inbox, queue, runsDirectory: directory, running });
  assert.equal(live.runs[0].status, "running");
  assert.equal(live.runs[0].running, true);

  // The same file, once this surface is no longer running it.
  const abandoned = await collectState({ inbox, queue, runsDirectory: directory, running: new Set() });
  assert.equal(abandoned.runs[0].status, "incomplete");
  assert.equal(abandoned.runs[0].running, undefined);

  // And the sentence itself no longer claims what it cannot know.
  const receipt = await readReceipt(directory, "20260101000001-bbbb.jsonl");
  assert.match(
    receipt.outcome.reasons[0].text,
    /^the receipt has no terminal record: the run stopped before it could finish, or it is still going/,
  );
});

test("a rehearsal that never ran is not a rehearsal that found conflicts", async () => {
  // 'CONFLICTS:' with nothing after it is a claim with no evidence.
  const directory = await runsDirectory({
    "20260101000002-cccc.jsonl": [
      { runId: "20260101000002-cccc", type: "start" },
      {
        runId: "20260101000002-cccc",
        terminal: true,
        status: "succeeded",
        git: { mergeRehearsal: { rehearsed: true, clean: false, targetBranch: "main", conflicts: [] } },
        summary: { status: "succeeded", steps: {} },
      },
    ],
  });
  const receipt = await readReceipt(directory, "20260101000002-cccc.jsonl");
  // 'not clean' with nothing after it was a claim with no evidence.
  assert.equal(receipt.outcome.rehearsal.state, "conflicts");
  assert.match(receipt.outcome.rehearsal.text, /does not merge into main, with no file named/);

  // And a rehearsal that never ran is neither clean nor conflicting: the
  // fetch failed, so there was nothing to merge. Reporting that as 'not
  // clean' invents a conflict nobody found.
  const unrun = await runsDirectory({
    "20260101000003-dddd.jsonl": [
      { runId: "20260101000003-dddd", type: "start" },
      {
        runId: "20260101000003-dddd",
        terminal: true,
        status: "succeeded",
        git: { mergeRehearsal: { rehearsed: false, reason: "fetch-failed", targetBranch: "main", error: "could not read from remote" } },
        summary: { status: "succeeded", steps: {} },
      },
    ],
  });
  const never = await readReceipt(unrun, "20260101000003-dddd.jsonl");
  assert.equal(never.outcome.rehearsal.state, "not-rehearsed");
  assert.match(never.outcome.rehearsal.text, /not rehearsed against main: the target branch could not be fetched/);
  assert.equal(never.outcome.rehearsal.error, "could not read from remote");

  // The terminal says the same, and does not colour it as a conflict.
  const { renderApp } = await import("../src/tui/render.js");
  const screen = renderApp(
    { runs: [{ runId: "20260101000003-dddd", status: "succeeded", mode: "execute", receiptFile: "20260101000003-dddd.jsonl" }] },
    { view: "runs", detail: true, color: false, receipt: never, width: 100, height: 40 },
  ).join("\n");
  assert.match(screen, /not rehearsed against main: the target branch could not be fetched/);
  assert.match(screen, /could not read from remote/);
  assert.equal(/\bconflicts\b/.test(screen), false, "a fetch that failed found no conflict");
});

test("a run says where its files are and what it did to them", async () => {
  // Asked: 'the task was to create test.txt and I cannot find the file'. A run
  // in a worktree writes it there, uncommitted, and the checkout shows
  // nothing. 'BRANCH etnpilot/run-…' does not tell anyone where to look.
  const directory = await runsDirectory({
    "20260101000004-eeee.jsonl": [
      {
        runId: "agent-1",
        result: { toolCalls: [{ tool: "write_file", ok: true }, { tool: "read_file", ok: false, error: "Denied by policy." }] },
      },
      {
        type: "workflow",
        terminal: true,
        runId: "20260101000004-eeee",
        status: "succeeded",
        workspace: {
          name: "run-20260101000004-eeee",
          branch: "etnpilot/run-20260101000004-eeee",
          path: "/repo/.etnpilot/worktrees/run-20260101000004-eeee",
          managed: true,
        },
        summary: { status: "succeeded", steps: { agent: { status: "succeeded" } } },
      },
    ],
  });
  const receipt = await readReceipt(directory, "20260101000004-eeee.jsonl");

  assert.equal(receipt.outcome.workspace.path, "/repo/.etnpilot/worktrees/run-20260101000004-eeee");
  assert.deepEqual(receipt.outcome.tools, [
    { tool: "write_file", ok: 1, failed: 0 },
    { tool: "read_file", ok: 0, failed: 1, error: "Denied by policy." },
  ]);
  // A refusal inside a run that ended 'succeeded' is not swallowed: the model
  // finishing its turn is not the same as the work being done.
  assert.equal(receipt.outcome.status, "succeeded");
  assert.match(
    receipt.outcome.reasons.map((reason) => reason.text).join("\n"),
    /read_file did not succeed: Denied by policy\./,
  );

  // The terminal says both, beside each other.
  const { renderApp } = await import("../src/tui/render.js");
  const screen = renderApp(
    { runs: [{ runId: "20260101000004-eeee", status: "succeeded", mode: "execute", receiptFile: "20260101000004-eeee.jsonl" }] },
    { view: "runs", detail: true, color: false, receipt, width: 100, height: 46 },
  ).join("\n");
  assert.match(screen, /Workspace/);
  assert.match(screen, /\/repo\/\.etnpilot\/worktrees\/run-20260101000004-eeee/);
  assert.match(screen, /write_file\s+1 ran/);
  assert.match(screen, /read_file\s+0 ran\s+1 refused/);
});

test("the agents that ran are read back as a tree, not a flat list of lines", async () => {
  // What the request was: see the agents that worked, hierarchically, and
  // click each one to read the full text of what it did. Every surface reads
  // this from the same place, so it agrees.
  const directory = await runsDirectory({
    "20260101000005-ffff.jsonl": [
      {
        runId: "agent-plan",
        agent: "orchestrator",
        workflowStep: "plan",
        provider: "openai",
        status: "succeeded",
        durationMs: 1200,
        approvals: [],
        result: { text: "1. Read README.md\n2. Write CHANGES.md", toolCalls: [] },
      },
      {
        runId: "agent-build",
        agent: "builder",
        workflowStep: "build",
        provider: "openai",
        status: "succeeded",
        durationMs: 3400,
        approvals: [{ operationKind: "write", decision: "approve-once" }],
        usage: { inputTokens: 500, outputTokens: 80, invocations: 1 },
        result: { text: "Wrote CHANGES.md.", toolCalls: [{ tool: "write_file", ok: true }] },
      },
      // A subagent the builder spawned mid-step: same shape, nested by
      // parentRunId rather than by workflowStep.
      {
        runId: "agent-build-sub",
        parentRunId: "agent-build",
        agent: "linter",
        provider: "openai",
        status: "failed",
        durationMs: 400,
        approvals: [],
        error: "lint failed: unexpected token",
        result: { text: "", toolCalls: [] },
      },
      {
        type: "workflow",
        terminal: true,
        runId: "20260101000005-ffff",
        status: "succeeded",
        summary: { status: "succeeded", steps: { plan: { status: "succeeded" }, build: { status: "succeeded" } } },
      },
    ],
  });
  const receipt = await readReceipt(directory, "20260101000005-ffff.jsonl");
  const agents = receipt.outcome.agents;

  assert.equal(agents.length, 2, "two workflow steps ran an agent, at the top level");
  const [plan, build] = agents;
  assert.equal(plan.workflowStep, "plan");
  assert.equal(plan.agent, "orchestrator");
  assert.match(plan.text, /Write CHANGES\.md/);
  assert.deepEqual(plan.children, []);

  assert.equal(build.workflowStep, "build");
  assert.equal(build.toolCalls[0].tool, "write_file");
  assert.equal(build.usage.inputTokens, 500);
  // The subagent nests under the agent that spawned it, not beside it.
  assert.equal(build.children.length, 1);
  assert.equal(build.children[0].agent, "linter");
  assert.equal(build.children[0].workflowStep, undefined);
  assert.equal(build.children[0].status, "failed");
  assert.match(build.children[0].error, /lint failed/);

  // The same tree reaches the CLI, untruncated: a real project, with this
  // receipt dropped into its own runs directory.
  const { runCli } = await import("../src/cli/commands.js");
  const { initializeProject } = await import("../src/config/init.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-agents-cli-"));
  await initializeProject(root);
  const projectRuns = join(root, ".etnpilot", "state", "runs");
  await mkdir(projectRuns, { recursive: true });
  await writeFile(
    join(projectRuns, "20260101000005-ffff.jsonl"),
    await readFile(join(directory, "20260101000005-ffff.jsonl"), "utf8"),
    "utf8",
  );
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(line);
  try {
    await runCli(["receipt", "show", "20260101000005-ffff.jsonl"], { root });
  } finally {
    console.log = log;
  }
  const shown = JSON.parse(printed.at(-1));
  assert.equal(shown.agents[1].children[0].agent, "linter");
});
