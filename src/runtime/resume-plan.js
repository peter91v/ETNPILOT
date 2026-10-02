// @ts-check
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../config/load.js";
import { canonicalJson, verifyReceiptFile } from "../core/receipt-store.js";
import { workspaceDigest } from "../git/workspace-digest.js";
import { readLines } from "./jsonl.js";
import { worktreeLockHolder } from "./worktree-lock.js";

// Which steps of an earlier run could be carried over into a new one, and if
// not, why not. It reads and checks; it changes nothing and runs nothing (see
// docs/entwurf-lauf-fortsetzen.md, section 5.3).
//
// The answer is a plan: `refusals` is empty when resuming is possible, and
// every refusal names the condition that failed. `steps` says, for each step
// of the run, whether its result would be reused, run again, or needs a
// person's say first.

/** @returns {Promise<any>} */
export async function planResume({
  root = process.cwd(),
  receipt,
  env = process.env,
  verifiers = new Map(),
  requireSignatures = false,
  allowDrift = false,
} = /** @type {any} */ ({})) {
  const repositoryRoot = resolve(root);
  const runsDirectory = join(repositoryRoot, ".etnpilot", "state", "runs");
  const path = resolveReceiptPath(runsDirectory, receipt);
  const refusals = [];
  const refuse = (code, message) => refusals.push({ code, message });

  // 1. The old receipt is what it claims to be.
  const verification = await verifyReceiptFile(path, { verifiers, requireSignatures, requireTerminal: false });
  if (!verification.valid) {
    return { receipt: path, resumable: false, refusals: [{ code: "receipt-does-not-verify", message: `The receipt does not verify (${/** @type {any} */ (verification).reason}).` }], steps: [] };
  }

  const entries = [];
  for await (const line of readLines(path)) if (line !== "") entries.push(JSON.parse(line));
  const start = entries.find((entry) => entry.type === "run-start");
  const terminal = entries.find((entry) => entry.terminal === true);
  const finished = new Map(entries.filter((entry) => entry.type === "step" && entry.status === "succeeded").map((entry) => [entry.step, entry]));

  if (!start) {
    return { receipt: path, resumable: false, refusals: [{ code: "no-run-start", message: "This receipt was written before runs recorded how they started, so there is nothing to compare the workspace and configuration against." }], steps: [] };
  }
  if (!Array.isArray(start.plan)) {
    return { receipt: path, resumable: false, refusals: [{ code: "no-step-plan", message: "This receipt does not say which steps the run had." }], steps: [] };
  }
  if (terminal?.status === "succeeded") {
    refuse("already-succeeded", "The run already finished successfully; there is nothing to continue.");
  }
  if (start.mode === "dry-run") {
    refuse("dry-run", "A dry run did nothing that could be resumed.");
  }

  // 2. Which steps would be carried over, in the run's own order. Only an
  // agent step that finished is carried over: its result is in the receipt.
  // Anything else is run again, and so is everything that needs it.
  const steps = [];
  const reuse = {};
  const carried = new Set();
  for (const step of start.plan) {
    const evidence = finished.get(step.id);
    const needsMet = (step.needs ?? []).every((id) => carried.has(id));
    const agentEntry = [...entries].reverse().find((entry) => entry.type === undefined && entry.workflowStep === step.id && entry.status === "succeeded" && entry.parentRunId === undefined);
    if (evidence && needsMet && step.type === "agent" && agentEntry) {
      carried.add(step.id);
      const { previousHash: _previous, hash, signature: _signature, proof: _proof, ...result } = agentEntry;
      reuse[step.id] = { result, entryHash: hash, effect: evidence.effect };
      steps.push({ id: step.id, type: step.type, action: "reuse", effect: evidence.effect, entryHash: hash, workspaceDigest: evidence.workspaceDigest?.digest });
    } else {
      const reason = !evidence
        ? "did not finish"
        : step.type !== "agent"
          ? "only agent steps are carried over; this kind runs again"
          : !needsMet
            ? "a step it needs is not carried over"
            : "its result is not in the receipt";
      steps.push({ id: step.id, type: step.type, action: "rerun", reason });
    }
  }
  if (steps.every((step) => step.action === "reuse")) {
    refuse("nothing-left", "Every step finished; the run stopped after them (while sealing or publishing), which a new run cannot help with.");
  }
  if (!start.request?.input) {
    refuse("no-request", "The receipt does not record what was asked, so the run cannot be asked again.");
  }

  // 3. The workspace is as the last finished step left it.
  // The state to match is the one the last step to finish (of any kind) left:
  // that is where the work stands now.
  const lastFinished = [...entries].reverse().find((entry) => entry.type === "step" && entry.status === "succeeded");
  const lastDone = lastFinished ? { id: lastFinished.step } : undefined;
  const expected = lastFinished?.workspaceDigest?.digest ?? start.workspaceDigest?.digest;
  const workspacePath = start.workspace?.path;
  const holder = workspacePath ? await worktreeLockHolder(repositoryRoot, workspacePath) : undefined;
  if (holder) {
    refuse("workspace-in-use", `Another run is working in that worktree (process ${holder.pid}, since ${holder.since}${holder.label ? `, ${holder.label}` : ""}).`);
  }
  if (!workspacePath) {
    refuse("no-workspace", "The receipt does not say where the run worked.");
  } else if (!expected) {
    refuse("no-workspace-digest", "No workspace digest was recorded to compare against (the directory was not a git working tree).");
  } else {
    const now = await workspaceDigest(workspacePath);
    if (now.unavailable) {
      refuse("workspace-gone", `The run's workspace can no longer be read (${now.unavailable}).`);
    } else if (now.digest !== expected) {
      refuse("workspace-changed", `The workspace differs from how ${lastDone ? `step '${lastDone.id}'` : "the run start"} left it (${expected} then, ${now.digest} now).`);
    }
  }

  // 4. The configuration is the one the run started under.
  let configDigest;
  try {
    const config = await loadConfig(join(workspacePath ?? repositoryRoot, ".etnpilot", "etnpilot.yaml"), env, { layerRoot: repositoryRoot });
    configDigest = `sha256:${createHash("sha256").update(canonicalJson(config)).digest("hex")}`;
  } catch (error) {
    refuse("config-unreadable", `The configuration cannot be read now (${error.message}).`);
  }
  const drift = configDigest !== undefined && configDigest !== start.configDigest;
  if (drift && !allowDrift) {
    refuse("config-changed", "The configuration differs from the one the run started under. Review it, or allow the drift explicitly.");
  }

  // 5. Steps with an effect outside the workspace that did not finish are not
  // repeated by themselves: whether they happened is unknown.
  for (const step of steps) {
    if (step.action === "rerun" && step.type === "publish") step.needsConfirmation = true;
  }

  const resumable = refusals.length === 0;
  const failure = describeFailure(terminal);
  const notes = [];
  if (steps.every((step) => step.action === "rerun")) {
    notes.push("Nothing from the earlier run can be carried over, so resuming keeps its worktree but runs every step again.");
  }
  const costSoFar = entries.filter((entry) => entry.usage?.estimatedCost !== undefined).reduce((sum, entry) => sum + entry.usage.estimatedCost, 0);
  return {
    receipt: path,
    runId: start.runId,
    status: terminal?.status ?? "incomplete",
    ...(failure ? { failure } : {}),
    notes,
    resumable,
    refusals,
    drift: drift ? { was: start.configDigest, now: configDigest } : undefined,
    workspace: workspacePath,
    resume: resumable ? {
      from: { runId: start.runId, receiptHash: /** @type {any} */ (verification).lastHash },
      workspace: { path: workspacePath, branch: start.workspace?.branch },
      reuse,
      request: start.request,
    } : undefined,
    steps,
    costSoFar: costSoFar > 0 ? costSoFar : undefined,
  };
}

function resolveReceiptPath(runsDirectory, receipt) {
  if (!receipt || typeof receipt !== "string") throw new TypeError("Name a run or a receipt file to resume.");
  const name = receipt.endsWith(".jsonl") ? receipt : `${receipt}.jsonl`;
  const candidate = name.includes(sep) || name.includes("/") ? resolve(name) : join(runsDirectory, name);
  if (dirname(candidate) !== runsDirectory) {
    throw new TypeError(`A receipt to resume must be one of this project's runs (${basename(runsDirectory)}/).`);
  }
  return candidate;
}

// Why the run stopped, from what its sealing entry kept: the step that failed
// and what it said, or the run's own error.
function describeFailure(terminal) {
  const summary = terminal?.summary;
  if (!summary) return undefined;
  const failedStep = Object.entries(summary.steps ?? {}).find(([, step]) => step?.status === "failed");
  if (failedStep) return { step: failedStep[0], error: String(failedStep[1].error ?? "").slice(0, 500) || undefined };
  if (summary.error) return { error: String(summary.error).slice(0, 500) };
  return undefined;
}
