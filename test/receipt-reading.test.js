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
