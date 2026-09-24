import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { escapeControlCharacters } from "../core/text-safety.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabClient } from "../gitlab/client.js";
import { summarizeTelemetryFile } from "../observability/telemetry.js";
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
  // Runs started from a surface are tracked here rather than in each surface:
  // the TUI and the page both need to say what is running, and closing either
  // one must stop what it started rather than stranding it.
  const running = new Set();
  const runErrors = [];
  return {
    root: projectRoot,
    get config() { return current; },
    inbox,
    queue,
    runsDirectory,
    collect: (options) => collectState(
      { inbox, queue, runsDirectory, root: projectRoot, env, running, runErrors },
      options,
    ),
    settings: () => describeSettings({ root: projectRoot, env }),
    get active() { return [...running].map(presentRun); },
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
      const task = String(input).trim();
      // The run owns a controller of its own, so 'stop everything' works even
      // for a caller that passed no signal — a browser tab cannot pass one.
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const record = { task, agent, startedAt: new Date().toISOString(), controller, done: 0 };
      const started = runProject({
        root: projectRoot,
        env,
        input: task,
        agent,
        signal: controller.signal,
        // Where the run is, so a surface can say more than 'working'.
        onEvent: (event) => {
          if (event.type === "workflow.planned") {
            record.runId = event.runId;
            record.steps = event.steps;
          }
          if (event.type === "workflow.step.started") {
            record.step = event.step;
            record.stepSince = event.at;
            record.stepAgent = undefined;
          }
          if (event.type === "run.started") record.stepAgent = event.agent;
          if (event.type === "workflow.step.completed") {
            record.done += 1;
            record.step = undefined;
            record.stepAgent = undefined;
          }
          if (event.type === "workflow.step.failed") {
            record.done += 1;
            record.failed = event.step;
            record.error = event.error;
            record.step = undefined;
          }
        },
        dryRun,
        providerFactories,
        approvalHandler: createInboxApprovalHandler({
          inbox,
          timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
          pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
          signal: controller.signal,
        }),
      });
      running.add(record);
      // A surface that does not await the run — the page answers 202 and moves
      // on — must still learn that it failed, so the reason is kept here.
      started.then(
        () => running.delete(record),
        (error) => {
          running.delete(record);
          runErrors.unshift({ task, at: new Date().toISOString(), error: error.message });
          runErrors.length = Math.min(runErrors.length, 5);
        },
      );
      return started;
    },
    // Whoever closes the surface stops what that surface started; a run left
    // working in a worktree nobody watches is worse than one that says why it
    // stopped, which its receipt records.
    stopRuns() {
      const stopped = [...running].map(presentRun);
      for (const record of running) record.controller.abort();
      return stopped;
    },
    // Receipts are read on demand rather than in every poll: a detail view is
    // opened now and then, and the files grow with the run.
    readReceipt: async (file) => {
      const receipt = await readReceipt(runsDirectory, file);
      // Whether the run is still going is not in the file: a receipt with no
      // terminal record looks the same while it is being written and after it
      // was abandoned. This surface knows what it started, so it says so.
      const runId = file.replace(/\.jsonl$/, "");
      const active = runId !== undefined && [...running].some((record) => record.runId === runId);
      return active
        ? { ...receipt, outcome: describeOutcome(receipt, { running: true }) }
        : receipt;
    },
    // Worktrees and merge requests are read on demand for the same reason,
    // more sharply: one runs 'git status' per worktree, the other crosses the
    // network. A poll every second must do neither.
    worktrees: () => readWorktrees({ root: projectRoot, config: current }),
    // What a worktree is holding, so 'it keeps unsaved work' can be read as a
    // list of files rather than a number to be taken on trust.
    async worktreeChanges(name) {
      const manager = worktreeManager(projectRoot, current);
      const entry = (await manager.describe()).find((candidate) => candidate.name === name);
      if (!entry) throw new TypeError(`'${name}' is not a worktree of this project.`);
      if (entry.readable === false) {
        return { name, path: entry.path, entries: [], total: 0, blocking: 0, unreadable: true };
      }
      return { name, branch: entry.branch, ...await manager.changesAt(entry.path) };
    },
    // One file's diff, so 'modified' can be read as the lines it changed. The
    // file must be one this worktree itself reported as changed: a name from a
    // surface never decides what is read from disk.
    async worktreeDiff(name, file) {
      const manager = worktreeManager(projectRoot, current);
      const entry = (await manager.describe()).find((candidate) => candidate.name === name);
      if (!entry) throw new TypeError(`'${name}' is not a worktree of this project.`);
      const changes = await manager.changesAt(entry.path);
      const change = changes.entries.find((candidate) => candidate.path === file);
      if (!change) throw new TypeError(`'${file}' is not a changed file in '${name}'.`);
      if (change.binary || change.large || change.directory) {
        return { name, file, ...change, lines: [], reason: change.binary ? "binary" : change.large ? "too large" : "a directory" };
      }
      const diff = await manager.diffAt(entry.path, file, { untracked: change.label === "untracked" });
      return { name, file, ...change, ...parseDiff(diff.text), truncated: diff.truncated === true };
    },
    removeWorktree: (name) => worktreeManager(projectRoot, current).removeIfClean(name),
    // What the provider cost. Read on demand and only when the telemetry file
    // has changed, because it is the whole file every time.
    usage: () => readUsage({ root: projectRoot, config: current }),
    // Which agents this project has, so a surface can offer them by name
    // instead of asking a person to remember how they spelled one.
    agents: () => readAgents({ root: projectRoot, config: current }),
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
      for (const record of running) record.controller.abort();
      inbox.close();
      queue.close();
    },
  };
}

export async function collectState(
  { inbox, queue, runsDirectory, root, env, running = new Set(), runErrors = [] },
  { runLimit = 20 } = {},
) {
  return {
    generatedAt: new Date().toISOString(),
    root,
    settings: root ? await describeSettings({ root, env }).catch(settingsUnreadable) : undefined,
    // What this process started and has not finished, so a surface can say a
    // run is working before it has produced a receipt to read.
    active: [...running].map(presentRun),
    recentRunErrors: [...runErrors],
    approvals: {
      pending: inbox.list({ status: "pending", limit: 50 }),
      recent: inbox.list({ status: "all", limit: 20 }),
    },
    queue: { counts: queue.counts(), jobs: queue.list({ status: "all", limit: 20 }) },
    // A run this process is running right now has a receipt on disk with no
    // terminal record yet. Reading that as a run that stopped is how a row
    // said 'incomplete' one minute and 'succeeded' the next, with nobody
    // touching anything.
    runs: markRunning(await readRuns(runsDirectory, { limit: runLimit }), running),
  };
}

function markRunning(runs, running) {
  const active = new Set([...running].map((record) => record.runId).filter(Boolean));
  if (active.size === 0) return runs;
  return runs.map((run) => (run.terminal || !active.has(run.runId)
    ? run
    : { ...run, status: "running", running: true }));
}

function presentRun(record) {
  return {
    task: record.task,
    agent: record.agent,
    startedAt: record.startedAt,
    ...(record.steps ? { steps: record.steps, done: record.done } : {}),
    ...(record.step ? { step: record.step, stepSince: record.stepSince } : {}),
    ...(record.stepAgent ? { stepAgent: record.stepAgent } : {}),
    ...(record.failed ? { failedStep: record.failed, error: record.error } : {}),
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
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // A malformed line is reported by 'etnpilot receipt verify'.
      }
    }
    if (parsed.length === 0) continue;
    // The last line is not the terminal record: a run that stopped before it
    // could seal leaves an ordinary entry there, and reading that entry's own
    // status, hash and duration as the run's reports a step's success as the
    // run's. What is sealed is what carries 'terminal: true', and nothing
    // else.
    const sealed = parsed.findLast((entry) => entry.terminal === true);
    runs.push({
      // A receipt carries two kinds of id: each agent invocation writes its
      // own, and the workflow writes the run's. The run's is what every
      // surface names and what the file is called, so an unsealed receipt
      // takes it from the file rather than from the first agent that happened
      // to write a line.
      runId: sealed?.runId ?? file.replace(/\.jsonl$/, ""),
      status: sealed?.status ?? "incomplete",
      mode: sealed?.mode ?? parsed.find((entry) => typeof entry.mode === "string")?.mode ?? "execute",
      terminal: Boolean(sealed),
      entries: lines.length,
      hash: sealed?.hash,
      signed: Boolean(sealed?.proof),
      durationMs: sealed?.durationMs,
      branch: sealed?.workspace?.branch,
      sandbox: sealed?.workspace?.sandbox?.image,
      approvals: countApprovals(lines),
      receiptFile: file,
    });
  }
  return runs;
}

// Why a run ended the way it did, from what the receipt already holds. Both
// surfaces ask this module rather than each reading the entries their own way,
// so neither can give a different answer about the same run.
export function describeOutcome(receipt, { running = false } = {}) {
  const terminal = receipt?.terminal ?? {};
  const summary = terminal.summary ?? {};
  const steps = Object.entries(summary.steps ?? {}).map(([id, step]) => ({ id, ...step }));
  const failed = steps.filter((step) => step.status === "failed");
  const blocked = steps.filter((step) => step.status === "blocked");
  const rejected = receipt?.entries?.flatMap((entry) => entry.approvals ?? [])
    .filter((approval) => approval.decision && approval.decision !== "approve-once") ?? [];
  const reasons = [];
  // The fatal error first: it is what actually stopped the run.
  if (summary.error) reasons.push({ kind: "error", text: summary.error });
  for (const step of failed) reasons.push({ kind: "step", step: step.id, text: step.error ?? "failed", attempts: step.attempts });
  for (const step of blocked) {
    reasons.push({
      kind: "blocked",
      step: step.id,
      text: step.reason === "dependency-failed"
        ? "never ran: a step it needs failed"
        : step.reason === "fail-fast"
          ? "never ran: the workflow stops at the first failure"
          : step.reason ?? "never ran",
    });
  }
  for (const approval of rejected) {
    reasons.push({
      kind: "approval",
      text: `${approval.operationKind ?? "an operation"} was ${approval.decision}`
        + (approval.evidence?.reason ? `: ${approval.evidence.reason}` : ""),
    });
  }
  if (terminal.content?.verificationError) {
    reasons.push({ kind: "content", text: `content verification: ${terminal.content.verificationError}` });
  }
  // Not published is not a failure, but it is the first thing a reviewer asks.
  const publication = terminal.publication;
  if (publication && publication.published === false) {
    reasons.push({ kind: "publication", text: publicationReason(publication) });
  }
  if (terminal.terminal !== true && terminal.status === undefined) {
    // A receipt with no terminal record looks the same while it is being
    // written and after it was abandoned. Saying 'the run stopped' about one
    // that is still going is the surface inventing what it cannot see: a run
    // that then seals turns that sentence into a plain falsehood.
    reasons.push(running
      ? { kind: "running", text: "the run is still going: its receipt is sealed when it ends" }
      : {
        kind: "incomplete",
        text: "the receipt has no terminal record: the run stopped before it could finish,"
          + " or it is still going somewhere this surface did not start it",
      });
  }
  return {
    // 'incomplete' rather than 'unknown': a receipt with no terminal record
    // is not a run whose outcome could not be read, it is a run that never
    // reported one.
    status: terminal.status ?? summary.status ?? (receipt?.terminal ? "unknown" : running ? "running" : "incomplete"),
    sealed: Boolean(receipt?.terminal),
    steps,
    reasons,
    usage: terminal.observability?.summary,
    ...(terminal.git?.mergeRehearsal ? { rehearsal: describeRehearsal(terminal.git.mergeRehearsal) } : {}),
    ...(terminal.cleanup ? { cleanup: terminal.cleanup } : {}),
  };
}

const REHEARSAL_REASONS = Object.freeze({
  "fetch-failed": "the target branch could not be fetched",
  "merge-tree-unavailable": "this git does not support 'merge-tree --write-tree'",
});

// A merge that was never attempted is not a merge that is not clean. The
// rehearsal fetches the target branch first, and a fetch that fails leaves
// nothing to be clean or dirty about — reporting that as 'not clean' invents
// a conflict nobody found.
function describeRehearsal(rehearsal) {
  const target = rehearsal.targetBranch ?? "the target branch";
  if (rehearsal.rehearsed === false) {
    const why = REHEARSAL_REASONS[rehearsal.reason] ?? rehearsal.reason ?? "no reason recorded";
    return {
      state: "not-rehearsed",
      text: `not rehearsed against ${target}: ${why}`,
      ...(rehearsal.error ? { error: rehearsal.error } : {}),
    };
  }
  if (rehearsal.clean === true) return { state: "clean", text: `clean into ${target}` };
  const conflicts = rehearsal.conflicts ?? [];
  return conflicts.length > 0
    ? { state: "conflicts", text: `conflicts with ${target}: ${conflicts.join(", ")}`, conflicts }
    : { state: "conflicts", text: `does not merge into ${target}, with no file named`, conflicts };
}

function publicationReason(publication) {
  if (publication.reason === "workflow-not-succeeded") return "not published: the workflow did not succeed";
  if (publication.reason === "merge-conflict") {
    return `not published: it would conflict with ${(publication.conflicts ?? []).join(", ") || "the target branch"}`;
  }
  return `not published: ${publication.reason ?? "no reason recorded"}`;
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
  const receipt = { file, entries, terminal: entries.findLast((entry) => entry.terminal === true) };
  return { ...receipt, outcome: describeOutcome(receipt) };
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
// A unified diff, read as the lines it touches: every line carries the number
// it has on each side, so a surface can show where a change is rather than
// only what it says.
export function parseDiff(text, { limit = 2000 } = {}) {
  const lines = [];
  let oldLine = 0;
  let newLine = 0;
  let hunks = 0;
  let added = 0;
  let deleted = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (lines.length >= limit) return { lines, hunks, added, deleted, cut: true };
    if (line.startsWith("diff --git") || line.startsWith("index ")
      || line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("new file") || line.startsWith("deleted file")
      || line.startsWith("similarity index") || line.startsWith("rename ")
      || line.startsWith("old mode") || line.startsWith("new mode")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunks += 1;
      lines.push({ kind: "hunk", text: line, context: hunk[3].trim() });
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      lines.push({ kind: "note", text: line.slice(2) });
      continue;
    }
    if (hunks === 0) continue;
    if (line.startsWith("+")) {
      added += 1;
      lines.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      deleted += 1;
      lines.push({ kind: "remove", text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  // A diff that ends with a blank line is the split's doing, not the file's.
  while (lines.at(-1)?.kind === "context" && lines.at(-1).text === "") lines.pop();
  return { lines, hunks, added, deleted };
}

function worktreeManager(root, config) {
  return new WorktreeManager(root, config?.git?.worktreeRoot ?? ".etnpilot/worktrees");
}

// The agents a run can be given, read from the manifests the run itself would
// load. A name typed by hand is a run that fails a minute later.
export async function readAgents({ root, config }) {
  const directory = join(resolve(root), ".etnpilot", "agents");
  const files = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const agents = [];
  for (const file of files.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
    const content = await readFile(join(directory, file), "utf8").catch(() => "");
    let manifest;
    try {
      manifest = YAML.parse(content) ?? {};
    } catch (error) {
      // A manifest that does not parse is named rather than hidden: a run
      // would fail on it too.
      agents.push({ name: file.replace(/\.ya?ml$/, ""), file, error: error.message });
      continue;
    }
    // What it would actually run with: its own provider, or the project's.
    const provider = manifest.provider ?? (manifest.providers?.length ? undefined : config?.defaultProvider);
    agents.push({
      name: typeof manifest.name === "string" && manifest.name ? manifest.name : file.replace(/\.ya?ml$/, ""),
      file,
      ...(provider ? { provider, ...(manifest.provider ? {} : { inheritedProvider: true }) } : {}),
      ...(Array.isArray(manifest.requires) ? { requires: manifest.requires } : {}),
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    });
  }
  return {
    agents,
    // What an empty choice means, so the surface does not have to guess.
    defaultAgent: config?.defaultAgent,
    steps: (config?.workflow?.steps ?? []).map((step) => step.id ?? step.agent).filter(Boolean),
  };
}

// Tokens and cost for this project, as recorded by the runs themselves. A
// surface that never shows this leaves a budget nobody can see.
let usageCache;
export async function readUsage({ root, config }) {
  const file = resolve(root, config?.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
  const stats = await stat(file).catch(() => undefined);
  if (!stats) {
    return {
      available: false,
      reason: config?.observability?.enabled === true
        ? "No telemetry has been written yet; usage appears once a run records it."
        : "observability.enabled is false, so nothing records what a run costs.",
    };
  }
  const key = `${file}:${stats.mtimeMs}:${stats.size}`;
  if (usageCache?.key === key) return usageCache.value;
  const summary = await summarizeTelemetryFile(file);
  const value = { available: true, file, ...summary, budgets: config?.observability?.budgets ?? {} };
  usageCache = { key, value };
  return value;
}

export async function readWorktrees({ root, config }) {
  const manager = worktreeManager(root, config);
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
