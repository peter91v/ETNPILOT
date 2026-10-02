import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Waits for a condition by polling. The point of the helper is the failure: a
// timeout that only says "timed out" cannot be told apart from a slow machine,
// which is how flaky tests stay flaky. On a timeout this says how long it
// waited and, when given a way to look, what the thing under test was doing.
export async function waitFor(condition, what, { attempts = 300, intervalMs = 25, diagnose } = {}) {
  const started = Date.now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await delay(intervalMs);
  }
  let detail = "";
  if (diagnose) {
    try {
      detail = `\n--- what it was doing ---\n${await diagnose()}`;
    } catch (error) {
      detail = `\n(diagnosis failed: ${error.message})`;
    }
  }
  assert.fail(`Timed out after ${Date.now() - started} ms waiting for ${what}.${detail}`);
}

// A screen, the messages and the runs of a TUI window, as text.
export async function describeTui(app, state, screenText) {
  const collected = await state.collect().catch((error) => ({ error: error.message }));
  return [
    `screen:\n${screenText(app)}`,
    `message: ${app.message ?? "(none)"}`,
    `active: ${JSON.stringify((app.active ?? []).map((run) => ({ task: run.task, step: run.step, agent: run.agent })))}`,
    `recent run errors: ${JSON.stringify(collected.recentRunErrors ?? collected.error ?? [])}`,
    `pending approvals: ${collected.approvals?.pending?.length ?? "?"}`,
  ].join("\n");
}
