import { resolve } from "node:path";
import { runCheck } from "../checks/runner.js";
import { verifyReceiptText } from "../core/receipt-store.js";
import { readRegularFile } from "./bounded-io.js";
import { commandEnvironment } from "./command-environment.js";
import { loadConfig } from "../config/load.js";
import { createSandbox } from "./sandbox.js";
import { join } from "node:path";

// A model's answer cannot be replayed, and pretending otherwise would be a
// lie. What a receipt does capture exactly is the deterministic half of a run:
// which checks ran and what they returned. Replay re-runs those against a
// workspace and reports where reality has drifted from the record.
export async function replayRun(receiptPath, {
  root = process.cwd(),
  verifiers = new Map(),
  requireSignatures = false,
  requireTerminal = true,
  inspectOnly = false,
  env = process.env,
  signal,
  execute = runCheck,
} = {}) {
  const path = resolve(receiptPath);
  const content = (await readRegularFile(path, 16 * 1024 * 1024, { signal })).toString("utf8");
  const verification = verifyReceiptText(content, { verifiers, requireSignatures, requireTerminal });
  if (!verification.valid) return { receipt: path, receiptValid: false, receiptReason: verification.reason, checks: [], drifted: [], replayable: false };
  const entries = readEntries(content);
  const config = await loadConfig(join(resolve(root), ".etnpilot/etnpilot.yaml"), env).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
  const passedEnv = commandEnvironment(env, config.checks);
  const sandbox = createSandbox(config.sandbox, { workspace: resolve(root) });
  if (sandbox && !inspectOnly) await sandbox.assertAvailable();
  const terminal = entries.findLast((entry) => entry.terminal === true) ?? entries.at(-1);
  if (!terminal) throw new Error(`Receipt '${path}' contains no entries.`);

  const steps = Object.entries(terminal.summary?.steps ?? {});
  const checks = steps.filter(([, state]) => Array.isArray(state.result?.command));
  const agents = steps.filter(([, state]) => state.result?.agent !== undefined);

  const replayedChecks = [];
  for (const [id, state] of checks) {
    signal?.throwIfAborted();
    const recorded = { exitCode: state.result.exitCode ?? null, status: state.status };
    if (inspectOnly || state.result.skipped === true) {
      replayedChecks.push({ id, command: state.result.command, recorded, replayed: null, verdict: inspectOnly ? "not-executed" : "not-recorded" });
      continue;
    }
    let replayed;
    try {
      const declared = state.result.declaredCommand ?? state.result.command;
      const command = sandbox ? sandbox.wrap(declared, { env: passedEnv, cwd: resolve(root) }) : declared;
      const result = await execute({ name: id, command }, { cwd: resolve(root), env: passedEnv, signal });
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

function readEntries(content) {
  return content.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Receipt line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}
