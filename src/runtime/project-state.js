// @ts-check
export * from "./receipt-views.js";
export * from "./project-reads.js";
import { checkRunReadiness, readAgents, readMergeRequests, readUsage, readWorktrees, worktreeManager } from "./project-reads.js";
import { countRuns, describeOutcome, parseDiff, readReceipt, readRuns, verifyProjectReceipt, withCurrentPricing } from "./receipt-views.js";

import { createAgent, createWorkflow, lockReviewedContent, removeContent, updateAgent, updateWorkflow, readAgentDetails, readContentFile, readContentReview, readWorkflows } from "./project-content.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox } from "../core/approval-inbox.js";
import { chatApi } from "./project-chat.js";
import { startProjectRun } from "./project-run-start.js";
import { listChecks, runProjectCheck } from "./project-checks.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { resolveConfiguredApiKey } from "../providers/register.js";
import { knownPriceFor } from "../observability/known-pricing.js";
import { WorkflowQueue } from "../workflow/queue.js";

// These name files this state opened when it started. Changing one is allowed,
// but the open handles cannot follow it, so a surface says so rather than
// showing a setting that has visibly changed and quietly has not.
const HELD_OPEN = Object.freeze(["queue.database", "approval.inbox.database"]);

// What every surface reads: approvals waiting, the queue, and finished runs
// taken from their receipt files. One implementation, so the terminal, the
// TUI and the page can never disagree about what is true.
export async function openProjectState({ root = process.cwd(), env = process.env } = /** @type {any} */ ({})) {
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
  const runErrors = /** @type {any[]} */ ([]);
  // What the parts that moved out of this function share with it. The
  // configuration is read through a getter because changing a setting replaces it.
  const scope = { projectRoot, env, inbox, queue, runsDirectory, running, runErrors, get config() { return current; } };
  const self = {
    root: projectRoot,
    get config() { return current; },
    inbox,
    queue,
    runsDirectory,
    collect: (options) => collectState(
      { inbox, queue, runsDirectory, root: projectRoot, env, running, runErrors },
      options,
    ),
    // Conversations, read from the same place as everything else. Sending a
    // turn is not here: that starts a run, and starting runs is the caller's.
    // The state is not built yet while this object is, so the conversation half
    // reaches 'startRun' through it when it is called, not now.
    chat: chatApi(scope, { startRun: (options) => self.startRun(options) }),
    settings: () => describeSettings({ root: projectRoot, env }),
    // The models a configured provider can currently reach, read live — never
    // cached here, because the answer is the provider's own and changes on
    // its schedule. Only 'anthropic' and 'openai-compatible' expose a models
    // endpoint this project knows how to call; anything else says so rather
    // than guessing at one.
    async listProviderModels(name) {
      const providerConfig = current.providers?.[name];
      if (!providerConfig) throw new TypeError(`'${name}' is not a configured provider.`);
      const type = providerConfig.type;
      if (type !== "anthropic" && type !== "openai-compatible") {
        return { available: false, reason: `'${type}' has no models endpoint this project can call.` };
      }
      const resolver = createSecretResolver({ root: projectRoot, config: current, env });
      const apiKey = providerConfig.apiKey ?? await resolveConfiguredApiKey(type, providerConfig, { secretResolver: resolver, env });
      const module = type === "anthropic"
        ? await import("../providers/anthropic.js")
        : await import("../providers/openai-compatible.js");
      const all = await module.listModels({ baseUrl: providerConfig.baseUrl, apiKey });
      // Only ETNPilot's own judgment of which are chat-capable, for the
      // provider type whose listing endpoint does not separate them itself.
      const models = type === "openai-compatible" ? all.filter((model) => /** @type {any} */ (module).looksLikeChatModel(model.id)) : all;
      return {
        available: true,
        models: models.map((model) => ({ ...model, knownPrice: knownPriceFor(type, model.id) })),
      };
    },
    get active() { return [...running].map(presentRun); },
    decide: (id, decision, options) => inbox.decide(id, decision, options),
    cancelJob: (id, options) => queue.requestCancel(id, options),
    resumeJob: (id, options) => queue.resume(id, options),
    // A run started from a live surface asks that surface for its approvals:
    // the requests land in the same inbox the screen is already showing, so
    // nobody has to open a second window to answer their own run.
    // Whether a run started now would get past its first step. A worktree is made
    // from the committed base ref, so a project whose '.etnpilot/' was never
    // committed fails there, after the run has already been accepted. Asking
    // first lets a surface offer the way out while the person is still choosing.
    readiness: () => checkRunReadiness({ root: projectRoot, config: current }),
    // What a person reviews before content is used, and the lock that records
    // the review. Read from disk each time.
    content: () => readContentReview({ root: projectRoot, config: current }),
    contentFile: (path) => readContentFile({ root: projectRoot, config: current, path }),
    lockContent: (manifestDigest) => lockReviewedContent({ root: projectRoot, config: current, manifestDigest }),
    agentDetails: () => readAgentDetails({ root: projectRoot, config: current }),
    workflows: () => readWorkflows({ root: projectRoot, config: current }),
    createWorkflow: (input) => createWorkflow({ root: projectRoot, config: current, input }),
    createAgent: (input) => createAgent({ root: projectRoot, config: current, input }),
    updateAgent: (name, input) => updateAgent({ root: projectRoot, config: current, name, input }),
    updateWorkflow: (name, input) => updateWorkflow({ root: projectRoot, config: current, name, input }),
    removeContent: (kind, name) => removeContent({ root: projectRoot, config: current, kind, name }),
    startRun: (options) => startProjectRun(scope, options),
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
      const described = active
        ? { ...receipt, outcome: describeOutcome(receipt, { running: true }) }
        : receipt;
      return withCurrentPricing(described, { root: projectRoot, config: current, runId });
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
    // The checks that used to be CLI-only. Listing them is free; running one
    // is not, so it happens when a person asks — never in a poll — and every
    // surface calls this same registry rather than reimplementing a check per
    // window.
    checks: () => listChecks(),
    runCheck: (id) => runProjectCheck(id, { root: projectRoot, config: current }),
    // Whether a receipt is what it claims: the hash chain, and the signature
    // where the project signs. The same name check 'readReceipt' applies, for
    // the same reason — a file name from a surface never decides what is read.
    verifyReceipt: (file) => verifyProjectReceipt(runsDirectory, file, { root: projectRoot, config: current }),
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
  return self;
}

export async function collectState(
  { inbox, queue, runsDirectory, root, env, running = new Set(), runErrors = /** @type {any[]} */ ([]) },
  { runLimit = 20 } = /** @type {any} */ ({}),
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
    runs: markRunning(await readRuns(runsDirectory, { limit: Math.min(Math.max(1, Math.trunc(runLimit) || 20), 500) }), running),
    // The list above is a window; this is how many receipts there are, so a
    // surface never presents the window's size as the count.
    runsTotal: await countRuns(runsDirectory),
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
    ...(record.session ? { session: record.session } : {}),
    ...(record.steps ? { steps: record.steps, done: record.done } : {}),
    ...(record.plan ? { plan: record.plan } : {}),
    ...(record.workflow ? { workflow: record.workflow } : {}),
    ...(record.agents ? { agents: record.agents } : {}),
    ...(record.step ? { step: record.step, stepSince: record.stepSince } : {}),
    ...(record.stepAgent ? { stepAgent: record.stepAgent } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.failed ? { failedStep: record.failed, error: record.error } : {}),
  };
}

// A local settings file that the loader refuses must not black out the rest of
// the screen: the surface still shows approvals and runs, and says what is
// wrong with the file.
function settingsUnreadable(error) {
  return { entries: [], layers: [], overrides: [], error: error.message };
}

