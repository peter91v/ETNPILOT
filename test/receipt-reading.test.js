import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  { runId: "20260101000001-bbbb", type: "start", mode: "execute" },
  // The last thing it managed to write: one step, which succeeded.
  { runId: "20260101000001-bbbb", step: "agent", status: "succeeded", hash: "entry-hash-9", durationMs: 12 },
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
  assert.equal(unsealed.runId, "20260101000001-bbbb", "the id comes from the run, not the file name");
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
    assert.deepEqual(newest.why, ["the receipt was never sealed: the run stopped before it could finish"]);

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
