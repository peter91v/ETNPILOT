import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeTaskCosts } from "../src/runtime/task-costs.js";

const line = (entry) => `${JSON.stringify(entry)}\n`;

test("cost per finished task counts every attempt, also the failed ones, and splits by rung and difficulty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "etn-costs-"));
  const run = (id, { status, cost, attempts = [], route }) => writeFile(join(dir, `${id}.jsonl`), [
    line({ type: "run-start", mode: "execute", runId: id }),
    ...(route ? [line({ type: "ladder-route", ...route })] : []),
    ...attempts.map((attempt) => line({ type: "ladder-attempt", ...attempt })),
    line({ type: "workflow", terminal: true, status, observability: cost === undefined ? undefined : { summary: { estimatedCost: cost } } }),
  ].join(""));
  await run("a", { status: "succeeded", cost: 0.10, attempts: [{ tier: 1, status: "passed", cost: 0.10 }], route: { difficulty: "simple", verify: "light" } });
  await run("b", { status: "succeeded", cost: 0.40, attempts: [{ tier: 1, status: "failed", cost: 0.10 }, { tier: 2, status: "passed", cost: 0.30 }], route: { difficulty: "medium", verify: "full" } });
  await run("c", { status: "failed", cost: 0.50, attempts: [{ tier: 1, status: "failed", cost: 0.50 }] });
  await run("d", { status: "succeeded" });
  await writeFile(join(dir, "dry.jsonl"), line({ type: "run-start", mode: "dry-run" }) + line({ type: "workflow", terminal: true, status: "succeeded" }));
  await writeFile(join(dir, "open.jsonl"), line({ type: "run-start", mode: "execute" }));
  await writeFile(join(dir, "broken.jsonl"), "not json\n");

  const tasks = await summarizeTaskCosts(dir);
  assert.equal(tasks.runs, 4, "a dry run and an unfinished one are no tasks");
  assert.equal(tasks.completed, 3);
  assert.equal(tasks.failed, 1);
  assert.equal(Number(tasks.cost.toFixed(2)), 1.0);
  assert.equal(Number(tasks.perCompleted.toFixed(4)), 0.3333, "all spend, including the failed run, over the finished tasks");
  assert.equal(tasks.byTier["tier 1"].completed, 1);
  assert.equal(tasks.byTier["tier 2"].perCompleted, 0.4);
  assert.equal(tasks.byDifficulty.simple.perCompleted, 0.1);
  assert.deepEqual((await summarizeTaskCosts(join(dir, "nowhere"))).runs, 0);
});
