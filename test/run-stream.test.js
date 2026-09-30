import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { readRuns } from "../src/runtime/project-state.js";
import { runCli } from "../src/cli/commands.js";

// P2.5 and P2.6: a pipeline can see what is happening, and a poll stops
// re-reading receipts that cannot have changed.

test("'--events jsonl' prints every event as it happens, and a last line either way", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-stream-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  // No project configuration, so the run fails early — which is the case that
  // matters: a stream that ends without a terminal line leaves a reader
  // waiting, with the reason only on stderr.
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    await runCli(["run", "do", "something"], { root, events: "jsonl" }).catch(() => {});
  } finally {
    console.log = original;
  }
  assert.equal(printed.length > 0, true);
  for (const line of printed) JSON.parse(line);
  const last = JSON.parse(printed.at(-1));
  assert.equal(["run.result", "run.error"].includes(last.type), true, `last line was ${last.type}`);
  assert.equal(typeof last.at, "string");
});

test("an unknown --events format is refused rather than silently ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-stream-bad-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await assert.rejects(
    () => runCli(["run", "x"], { root, events: "ndjson" }),
    /Unknown --events format 'ndjson'/,
  );
});

test("a sealed receipt is parsed once; one still being written is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-poll-"));
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true });

  const sealedStore = new JsonlReceiptStore(join(runs, "20260101000000-sealed00.jsonl"));
  await sealedStore.append({ runId: "sealed", agent: "a", status: "succeeded", approvals: [] });
  await sealedStore.append({ runId: "sealed", terminal: true, status: "succeeded", approvals: [] });

  const openStore = new JsonlReceiptStore(join(runs, "20260101000001-open0000.jsonl"));
  await openStore.append({ runId: "open", agent: "a", status: "succeeded", approvals: [] });

  const cache = new Map();
  const first = await readRuns(runs, { cache });
  assert.equal(first.length, 2);
  // Only the sealed one is kept: the other is still being appended to, and
  // its answer changes with the next line.
  assert.equal(cache.size, 1);
  assert.match([...cache.keys()][0], /sealed/);

  const second = await readRuns(runs, { cache });
  assert.deepEqual(second, first, "the same answer, without reading the file again");

  // Appending to the open receipt changes what it says, and the next poll
  // sees it — which is the whole reason an unsealed one is never cached.
  await openStore.append({ runId: "open", terminal: true, status: "failed", approvals: [] });
  const third = await readRuns(runs, { cache });
  const open = third.find((run) => run.runId === "open");
  assert.equal(open.status, "failed");
  assert.equal(open.terminal, true);
  assert.equal(cache.size, 2, "now that it is sealed, it is worth keeping");

  // A receipt that changes despite being sealed — which should not happen, and
  // is what 'receipt verify' is for — is still re-read rather than trusted.
  await writeFile(join(runs, "20260101000000-sealed00.jsonl"),
    `${JSON.stringify({ runId: "sealed", terminal: true, status: "failed", approvals: [], hash: "x", previousHash: null })}\n`);
  const fourth = await readRuns(runs, { cache });
  assert.equal(fourth.find((run) => run.runId === "sealed").status, "failed");
});

test("a run that leaves the window leaves the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-poll-window-"));
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    const store = new JsonlReceiptStore(join(runs, `2026010100000${index}-run00000.jsonl`));
    await store.append({ runId: `run-${index}`, terminal: true, status: "succeeded", approvals: [] });
  }
  const cache = new Map();
  await readRuns(runs, { cache, limit: 5 });
  assert.equal(cache.size, 5);
  // Otherwise a long-lived surface keeps every receipt it has ever shown.
  await readRuns(runs, { cache, limit: 2 });
  assert.equal(cache.size, 2);
});
