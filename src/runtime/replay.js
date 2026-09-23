import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCheck } from "../checks/runner.js";
import { verifyReceiptFile } from "../core/receipt-store.js";

// A model's answer cannot be replayed, and pretending otherwise would be a
// lie. What a receipt does capture exactly is the deterministic half of a run:
// which checks ran and what they returned. Replay re-runs those against a
// workspace and reports where reality has drifted from the record.
export async function replayRun(receiptPath, {
  root = process.cwd(),
  verifiers = new Map(),
  requireSignatures = false,
  env = process.env,
  signal,
  execute = runCheck,
} = {}) {
  const path = resolve(receiptPath);
  const verification = await verifyReceiptFile(path, { verifiers, requireSignatures });
  const entries = await readEntries(path);
  const terminal = entries.findLast((entry) => entry.terminal === true) ?? entries.at(-1);
  if (!terminal) throw new Error(`Receipt '${path}' contains no entries.`);

  const steps = Object.entries(terminal.summary?.steps ?? {});
  const checks = steps.filter(([, state]) => Array.isArray(state.result?.command));
  const agents = steps.filter(([, state]) => state.result?.agent !== undefined);

  const replayedChecks = [];
  for (const [id, state] of checks) {
    signal?.throwIfAborted();
    const recorded = { exitCode: state.result.exitCode ?? null, status: state.status };
    if (state.result.skipped === true) {
      replayedChecks.push({ id, command: state.result.command, recorded, replayed: null, verdict: "not-recorded" });
      continue;
    }
    let replayed;
    try {
      const result = await execute({ name: id, command: state.result.command }, { cwd: resolve(root), env, signal });
      replayed = { exitCode: result.exitCode ?? 0, status: "succeeded" };
    } catch (error) {
      replayed = { exitCode: error.result?.exitCode ?? null, status: "failed", error: error.message };
    }
    replayedChecks.push({
      id,
      command: state.result.command,
      recorded,
      replayed,
      verdict: replayed.status === recorded.status && replayed.exitCode === recorded.exitCode ? "matches" : "drifted",
    });
  }

  return {
    receipt: path,
    runId: terminal.runId,
    mode: terminal.mode ?? "execute",
    recordedStatus: terminal.status,
    receiptValid: verification.valid,
    ...(verification.valid ? {} : { receiptReason: verification.reason }),
    workspace: resolve(root),
    // What the record says a human allowed, and what the providers were asked.
    approvals: agents.flatMap(([id, state]) => (state.result.approvals ?? []).map((approval) => ({
      step: id,
      operationKind: approval.operationKind,
      decision: approval.decision,
      ...(approval.policy ? { policy: approval.policy } : {}),
    }))),
    providerAttempts: agents.flatMap(([id, state]) => (state.result.providerAttempts ?? []).map((attempt) => ({
      step: id,
      ...attempt,
    }))),
    checks: replayedChecks,
    drifted: replayedChecks.filter((check) => check.verdict === "drifted").map((check) => check.id),
    replayable: replayedChecks.length > 0,
  };
}

async function readEntries(path) {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Receipt line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}
