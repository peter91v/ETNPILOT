import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyGc, planGc } from "../src/runtime/gc.js";
import { runCli } from "../src/cli/commands.js";

const DAY = 86_400_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-gc-"));
  const state = join(root, ".etnpilot", "state");
  const runs = join(state, "runs");
  await mkdir(runs, { recursive: true });
  const now = Date.now();
  const make = async (path, text, ageDays) => {
    await writeFile(path, text);
    const when = new Date(now - ageDays * DAY);
    await utimes(path, when, when);
  };
  const sealed = '{"a":1}\n{"terminal":true}\n';
  await make(join(runs, "old-sealed.jsonl"), sealed, 200);
  await make(join(runs, "old-open.jsonl"), '{"a":1}\n', 200);
  await make(join(runs, "recent.jsonl"), sealed, 5);
  await make(join(runs, "notes.txt"), "not ours", 400);
  await make(join(state, "telemetry.jsonl"), "{}\n", 0);
  await make(join(state, "telemetry.jsonl.1700000000000"), "{}\n", 300);
  await make(join(state, "telemetry.jsonl.backup"), "{}\n", 300);
  return { root, runs, state, now };
}

test("gc plans only old, sealed receipts and old telemetry archives", async () => {
  const { root, now } = await fixture();
  const plan = await planGc({ root, olderThanDays: 90, keep: 0, now });
  assert.deepEqual(plan.candidates.map((file) => file.name).sort(), ["old-sealed.jsonl", "telemetry.jsonl.1700000000000"]);
  assert.equal(plan.kept.unsealed, 1);
  assert.equal(plan.kept.young, 1);
});

test("the newest receipts are kept whatever their age", async () => {
  const { root, now } = await fixture();
  const plan = await planGc({ root, olderThanDays: 90, keep: 10, now });
  assert.deepEqual(plan.candidates.map((file) => file.name), ["telemetry.jsonl.1700000000000"]);
});

test("nothing is deleted without --apply, and apply deletes exactly the plan", async () => {
  const { root, runs, now } = await fixture();
  const log = console.log;
  console.log = () => {};
  try {
    await runCli(["gc"], { root, "older-than": "90", keep: "0" });
    assert.ok((await readdir(runs)).includes("old-sealed.jsonl"));
    await runCli(["gc"], { root, "older-than": "90", keep: "0", apply: true });
  } finally { console.log = log; }
  const left = await readdir(runs);
  assert.deepEqual(left.sort(), ["notes.txt", "old-open.jsonl", "recent.jsonl"]);
  assert.equal((await applyGc(await planGc({ root, olderThanDays: 90, keep: 0, now }))).removed.length, 0);
});

test("bad numbers are refused", async () => {
  await assert.rejects(planGc({ olderThanDays: -1 }), /zero or more/);
  await assert.rejects(planGc({ keep: 1.5 }), /whole number/);
});
