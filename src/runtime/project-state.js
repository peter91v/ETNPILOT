import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { runProject } from "./project-runner.js";
import { WorkflowQueue } from "../workflow/queue.js";

// These name files this state opened when it started. Changing one is allowed,
// but the open handles cannot follow it, so a surface says so rather than
// showing a setting that has visibly changed and quietly has not.
const HELD_OPEN = Object.freeze(["queue.database", "approval.inbox.database"]);

// What every surface reads: approvals waiting, the queue, and finished runs
// taken from their receipt files. One implementation, so the terminal, the
// TUI and the page can never disagree about what is true.
export async function openProjectState({ root = process.cwd(), env = process.env } = {}) {
  const projectRoot = resolve(root);
  const config = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"), env);
  const inbox = new ApprovalInbox(
    resolve(projectRoot, config.approval?.inbox?.database ?? ".etnpilot/state/approvals.sqlite"),
    { redact: config.approval?.inbox?.redactSecrets === true },
  );
  const queue = new WorkflowQueue(
    resolve(projectRoot, config.queue?.database ?? ".etnpilot/state/workflows.sqlite"),
  );
  const runsDirectory = join(projectRoot, ".etnpilot", "state", "runs");

  let current = config;
  return {
    root: projectRoot,
    get config() { return current; },
    inbox,
    queue,
    runsDirectory,
    collect: (options) => collectState({ inbox, queue, runsDirectory, root: projectRoot, env }, options),
    decide: (id, decision, options) => inbox.decide(id, decision, options),
    cancelJob: (id, options) => queue.requestCancel(id, options),
    resumeJob: (id, options) => queue.resume(id, options),
    // A run started from a live surface asks that surface for its approvals:
    // the requests land in the same inbox the screen is already showing, so
    // nobody has to open a second window to answer their own run.
    startRun({ input, agent, signal, dryRun, providerFactories } = {}) {
      if (!input || !String(input).trim()) throw new TypeError("A task is required to start a run.");
      const inboxConfig = current.approval?.inbox ?? {};
      if (inboxConfig.enabled === false) {
        throw new Error("approval.inbox.enabled is false, so a run started here would have nobody to ask.");
      }
      return runProject({
        root: projectRoot,
        env,
        input: String(input).trim(),
        agent,
        signal,
        dryRun,
        providerFactories,
        approvalHandler: createInboxApprovalHandler({
          inbox,
          timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
          pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
          signal,
        }),
      });
    },
    // Receipts are read on demand rather than in every poll: a detail view is
    // opened now and then, and the files grow with the run.
    readReceipt: (file) => readReceipt(runsDirectory, file),
    // Changing a setting from any surface goes through the same module the
    // CLI uses, so every surface is refused for the same reason.
    async setSetting(path, value, options = {}) {
      const result = await setSetting(path, value, { root: projectRoot, env, ...options });
      current = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"), env);
      return { ...result, restartRequired: HELD_OPEN.includes(path) };
    },
    async unsetSetting(path, options = {}) {
      const result = await unsetSetting(path, { root: projectRoot, env, ...options });
      current = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"), env);
      return { ...result, restartRequired: HELD_OPEN.includes(path) };
    },
    close() {
      inbox.close();
      queue.close();
    },
  };
}

export async function collectState({ inbox, queue, runsDirectory, root, env }, { runLimit = 20 } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    settings: root ? await describeSettings({ root, env }).catch(settingsUnreadable) : undefined,
    approvals: {
      pending: inbox.list({ status: "pending", limit: 50 }),
      recent: inbox.list({ status: "all", limit: 20 }),
    },
    queue: { counts: queue.counts(), jobs: queue.list({ status: "all", limit: 20 }) },
    runs: await readRuns(runsDirectory, { limit: runLimit }),
  };
}

// A local settings file that the loader refuses must not black out the rest of
// the screen: the surface still shows approvals and runs, and says what is
// wrong with the file.
function settingsUnreadable(error) {
  return { entries: [], layers: [], overrides: [], error: error.message };
}

// Runs are read from their receipt files, so every surface shows what was
// sealed rather than a summary kept somewhere else.
export async function readRuns(directory, { limit = 20 } = {}) {
  const entries = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((name) => name.endsWith(".jsonl")).sort().reverse().slice(0, limit);
  const runs = [];
  for (const file of files) {
    const content = await readFile(join(directory, file), "utf8").catch(() => "");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let terminal;
    try {
      terminal = JSON.parse(lines.at(-1));
    } catch {
      continue;
    }
    runs.push({
      runId: terminal.runId ?? file.replace(/\.jsonl$/, ""),
      status: terminal.status ?? "unknown",
      mode: terminal.mode ?? "execute",
      terminal: terminal.terminal === true,
      entries: lines.length,
      hash: terminal.hash,
      signed: Boolean(terminal.proof),
      durationMs: terminal.durationMs,
      branch: terminal.workspace?.branch,
      sandbox: terminal.workspace?.sandbox?.image,
      approvals: countApprovals(lines),
      receiptFile: file,
    });
  }
  return runs;
}

export async function readReceipt(directory, file) {
  if (typeof file !== "string" || file.includes("/") || file.includes("\\") || !file.endsWith(".jsonl")) {
    throw new TypeError(`'${file}' is not a receipt file in this project.`);
  }
  const content = await readFile(join(directory, file), "utf8");
  const entries = [];
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ malformed: true });
    }
  }
  return { file, entries, terminal: entries.findLast((entry) => entry.terminal === true) };
}

function countApprovals(lines) {
  let total = 0;
  for (const line of lines) {
    try {
      total += (JSON.parse(line).approvals ?? []).length;
    } catch {
      // A malformed line is reported by 'etnpilot receipt verify', not here.
    }
  }
  return total;
}
