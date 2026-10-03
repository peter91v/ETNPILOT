// @ts-check
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readLines } from "./jsonl.js";

// What a finished task costs, read from the receipts: a task is a run, it is
// finished when its last entry says it succeeded, and what it cost counts every
// attempt, including the ones that failed on the way (that is the price of a
// cheap first try). Runs with a ladder are also split by the rung that passed
// and by what the router thought of the task, so the strategies can be compared
// on a project's own work instead of on someone's simulation.

export async function summarizeTaskCosts(runsDirectory, { limit = 500 } = /** @type {any} */ ({})) {
  const files = (await readdir(runsDirectory).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort().slice(-limit);
  const runs = [];
  for (const file of files) {
    const run = await readRun(join(runsDirectory, file));
    if (run) runs.push(run);
  }
  return aggregate(runs);
}

async function readRun(path) {
  let status;
  let observedCost;
  let currency;
  let mode = "execute";
  const attempts = [];
  let route;
  try {
    for await (const line of readLines(path)) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "run-start") mode = entry.mode ?? mode;
      if (entry.type === "ladder-attempt") attempts.push(entry);
      if (entry.type === "ladder-route") route = entry;
      if (entry.terminal === true) {
        status = entry.status;
        observedCost = entry.observability?.summary?.estimatedCost;
        currency = entry.observability?.summary?.currency;
      }
    }
  } catch {
    return undefined;
  }
  if (mode === "dry-run" || status === undefined) return undefined;
  const ladderCost = attempts.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const passed = attempts.find((entry) => entry.status === "passed");
  return {
    succeeded: status === "succeeded",
    // The run's own total when it was recorded; otherwise what the ladder's attempts add up to.
    currency,
    cost: typeof observedCost === "number" ? observedCost : (attempts.length > 0 ? ladderCost : undefined),
    attempts: attempts.length,
    passedTier: passed?.tier,
    difficulty: route?.difficulty,
    verify: route?.verify,
  };
}

function bucket() {
  return { runs: 0, completed: 0, cost: 0, priced: 0 };
}

function add(target, run) {
  target.runs += 1;
  if (run.succeeded) target.completed += 1;
  if (run.cost !== undefined) { target.cost += run.cost; target.priced += 1; }
}

function aggregate(runs) {
  const total = bucket();
  const byTier = /** @type {Record<string, any>} */ ({});
  const byDifficulty = /** @type {Record<string, any>} */ ({});
  for (const run of runs) {
    add(total, run);
    if (run.passedTier !== undefined) add(byTier[`tier ${run.passedTier}`] ??= bucket(), run);
    if (run.difficulty !== undefined) add(byDifficulty[run.difficulty] ??= bucket(), run);
  }
  const per = (entry) => ({ ...entry, perCompleted: entry.completed > 0 && entry.priced > 0 ? entry.cost / entry.completed : undefined });
  return {
    ...per(total),
    currency: runs.find((run) => run.currency)?.currency ?? "USD",
    failed: total.runs - total.completed,
    byTier: Object.fromEntries(Object.entries(byTier).map(([key, value]) => [key, per(value)])),
    byDifficulty: Object.fromEntries(Object.entries(byDifficulty).map(([key, value]) => [key, per(value)])),
  };
}
