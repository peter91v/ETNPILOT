import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { escapeControlCharacters } from "../core/text-safety.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabClient } from "../gitlab/client.js";
import { runProject, RUN_BRANCH_PREFIX } from "./project-runner.js";
import { createSecretResolver } from "../secrets/resolver.js";
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
    // Worktrees and merge requests are read on demand for the same reason,
    // more sharply: one runs 'git status' per worktree, the other crosses the
    // network. A poll every second must do neither.
    worktrees: () => readWorktrees({ root: projectRoot, config: current }),
    removeWorktree: (name) => new WorktreeManager(projectRoot).removeIfClean(name),
    mergeRequests: (options) => readMergeRequests({ root: projectRoot, config: current, env }, options),
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

// The worktrees this repository has, with ETNPilot's own marked and the
// branches they hold. A run works in one of these, so what is on disk is part
// of the same evidence as the receipt it wrote.
export async function readWorktrees({ root, config }) {
  const manager = new WorktreeManager(root, config?.git?.worktreeRoot ?? ".etnpilot/worktrees");
  try {
    const entries = await manager.describe();
    return {
      available: true,
      root: manager.worktreeRoot,
      entries,
      managed: entries.filter((entry) => entry.managed).length,
      unsaved: entries.filter((entry) => entry.readable && entry.blocking > 0).length,
    };
  } catch (error) {
    // Not a git checkout, or git is missing: a surface says that rather than
    // showing an empty list that looks like 'no worktrees'.
    return { available: false, error: error.message, entries: [] };
  }
}

// The merge requests ETNPilot opened, and the others queued for the same
// target, because what lands before ours is what breaks ours. Read straight
// from GitLab: a merge request's state lives there and nowhere else, and the
// receipt is sealed before publishing, so it cannot carry this.
export async function readMergeRequests({ root, config, env }, { state = "opened", fetchImpl, limit = 50 } = {}) {
  const project = config?.git?.project;
  if (!project) {
    return {
      configured: false,
      reason: "Set 'git.project' in .etnpilot/etnpilot.yaml to see merge requests here.",
      entries: [],
    };
  }
  let token;
  try {
    const secrets = createSecretResolver({ root, config, env });
    token = await secrets.get("gitlab.apiToken", {
      fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
    });
  } catch (error) {
    return { configured: true, available: false, project, error: error.message, entries: [] };
  }
  if (!token) {
    return {
      configured: true,
      available: false,
      project,
      error: "No GitLab API token is configured; set ETNPILOT_GITLAB_TOKEN or 'secrets.gitlab.apiToken'.",
      entries: [],
    };
  }
  const client = new GitLabClient({ baseUrl: config.git.baseUrl, token, fetchImpl });
  let mergeRequests;
  try {
    mergeRequests = await client.mergeRequests(project, { state, perPage: limit });
  } catch (error) {
    // Offline, or a token that cannot read this project. Either way the screen
    // reports it instead of pretending the project has no merge requests.
    return { configured: true, available: false, project, error: error.message, entries: [] };
  }
  const entries = mergeRequests.slice(0, limit).map((mergeRequest) => presentMergeRequest(mergeRequest));
  return {
    configured: true,
    available: true,
    project,
    state,
    targetBranch: config.git?.targetBranch ?? "main",
    entries,
    ours: entries.filter((entry) => entry.own).length,
    ...(mergeRequests.length > entries.length ? { truncated: mergeRequests.length } : {}),
  };
}

// Titles, branch names and author names are written by other people. They are
// data here, escaped and bounded, exactly as the merge-train inspection treats
// them.
function presentMergeRequest(mergeRequest) {
  const text = (value, max = 200) => escapeControlCharacters(String(value ?? "")).slice(0, max);
  const sourceBranch = text(mergeRequest.source_branch, 200);
  return {
    iid: Number(mergeRequest.iid),
    title: text(mergeRequest.title),
    state: text(mergeRequest.state, 20),
    draft: mergeRequest.draft === true || mergeRequest.work_in_progress === true,
    sourceBranch,
    targetBranch: text(mergeRequest.target_branch, 200),
    author: text(mergeRequest.author?.username ?? mergeRequest.author?.name ?? "", 60),
    webUrl: text(mergeRequest.web_url, 500),
    updatedAt: text(mergeRequest.updated_at, 40),
    mergeStatus: text(mergeRequest.detailed_merge_status ?? mergeRequest.merge_status ?? "", 40),
    hasConflicts: mergeRequest.has_conflicts === true,
    // Ours is decided by the branch a run publishes from, not by a name in the
    // title, which anyone could copy.
    own: sourceBranch.startsWith(RUN_BRANCH_PREFIX),
  };
}
