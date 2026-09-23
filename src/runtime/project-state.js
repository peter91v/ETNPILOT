import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox } from "../core/approval-inbox.js";
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
