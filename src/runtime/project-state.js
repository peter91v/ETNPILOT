export * from "./receipt-views.js";
export * from "./project-reads.js";
import { checkRunReadiness, readAgents, readMergeRequests, readUsage, readWorktrees, worktreeManager } from "./project-reads.js";
import { countRuns, describeOutcome, parseDiff, readReceipt, readRuns, verifyProjectReceipt, withCurrentPricing } from "./receipt-views.js";

import { readRegularFile } from "./bounded-io.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { compactSession, compactionCheck, createSessionId, listSessions, readSession, runChatTurn, undoLastTurn, verifySession } from "./chat-session.js";
import { resolveAttachments, summarizeAttachments } from "./chat-attachments.js";
import { PolicyEngine } from "../policy/engine.js";
import { git } from "../git/command.js";
import { createAgent, createWorkflow, lockReviewedContent, removeContent, updateAgent, updateWorkflow, readAgentDetails, readContentFile, readContentReview, readWorkflows } from "./project-content.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { describeSettings, setSetting, unsetSetting } from "../config/settings.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { listChecks, runProjectCheck } from "./project-checks.js";
import { runProject } from "./project-runner.js";
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
    chat: {
      list: () => listSessions(projectRoot),
      read: async (id) => {
        const session = await readSession(projectRoot, id);
        // Whether a turn is going now is known here and nowhere on disk.
        const active = [...running].find((record) => record.session === id);
        return { ...session, running: Boolean(active), ...(active?.partial ? { partial: active.partial } : {}) };
      },
      verify: (id) => verifySession(projectRoot, id, {
        verifyReceipt: (file) => verifyProjectReceipt(runsDirectory, file, { root: projectRoot, config: current }),
        readEntries: async (file) => {
          const text = await readRegularFile(join(runsDirectory, file), 16 * 1024 * 1024).then((bytes) => bytes.toString("utf8"));
          return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        },
      }),
      // Files a person can name with '@': what git tracks, minus what the read
      // policy refuses them. The same set search_files searches.
      async files(query = "", { limit = 50 } = {}) {
        const listed = await git(["ls-files", "-z"], { cwd: projectRoot, trim: false }).catch(() => ({ stdout: "" }));
        const policy = new PolicyEngine(current.policy);
        const needle = String(query).toLowerCase();
        const found = [];
        for (const path of listed.stdout.split("\0").filter(Boolean)) {
          if (needle && !path.toLowerCase().includes(needle)) continue;
          const verdict = policy.evaluateOperation({ kind: "read", path }, { workspace: projectRoot });
          if (verdict?.kind === "reject") continue;
          found.push(path);
          if (found.length >= limit) break;
        }
        return found;
      },
      // One turn of a conversation, started the way any run from a surface is:
      // its approvals land in the inbox this page already shows. Not awaited.
      async send({ sessionId, text, agent, model, provider, effort, providerFactories } = {}) {
        if (typeof text !== "string" || text.trim() === "") throw new TypeError("A message is required.");
        const id = sessionId ?? createSessionId();
        if ([...running].some((record) => record.session === id)) {
          throw new Error("A turn is already running in this conversation. Wait for it, or stop it.");
        }
        const lease = await acquireWorkspaceLease(projectRoot, { sessionId: id });
        try {
        const names = (await readAgents({ root: projectRoot, config: current })).agents.filter((entry) => !entry.error).map((entry) => entry.name);
        const chosen = agent ?? current.defaultAgent ?? "orchestrator";
        if (!names.includes(chosen)) throw new TypeError(`Unknown agent '${chosen}'. This project has: ${names.join(", ")}.`);
        if (provider) {
          const verdict = new PolicyEngine(current.policy).evaluateProvider(provider, { agent: chosen });
          if (verdict.allowed === false) throw new Error(verdict.reason ?? `The policy does not allow provider '${provider}'.`);
          if (!current.providers?.[provider]) throw new TypeError(`No provider '${provider}' is configured.`);
        }
        const policy = new PolicyEngine(current.policy);
        const { attachments, refused } = await resolveAttachments(text, {
          root: projectRoot,
          authorize: (path) => policy.evaluateOperation({ kind: "read", path }, { agent: chosen, workspace: projectRoot }),
        });
        const override = model || provider || effort ? { model, provider, effort } : undefined;
        const started = self.startRun({
          input: text.trim(),
          agent: chosen,
          providerFactories,
          session: id,
          // 'input' is dropped: the turn composes its own, with the attachments.
          via: ({ input: _task, agent: _agent, ...options }) => runChatTurn({
            ...options,
            workspaceLease: lease,
            sessionId: id,
            text: text.trim(),
            agent: chosen,
            attachments,
            agentOverride: override,
          }),
        });
        // A failure is reported through runErrors like any run's; nothing here waits.
        started.finally(() => lease.release()).catch(() => {});
        return { sessionId: id, agent: chosen, attached: summarizeAttachments(attachments), refused };
        } catch (error) { lease.release(); throw error; }
      },
      // Asks the model to summarise the older turns, as a run of its own. The
      // answer is not awaited; it lands in the session as a 'compact' line.
      async compact(id, { agent, model, provider, effort, providerFactories } = {}) {
        const check = await compactionCheck(projectRoot, id);
        if (!check.ok) return check;
        if ([...running].some((record) => record.session === id)) {
          return { ok: false, message: "A turn is running in this conversation; wait for it." };
        }
        const chosen = agent ?? current.defaultAgent ?? "orchestrator";
        const override = model || provider || effort ? { model, provider, effort } : undefined;
        const started = self.startRun({
          input: "Summarise the conversation",
          agent: chosen,
          providerFactories,
          session: id,
          via: ({ input: _task, agent: _agent, ...options }) => compactSession({ ...options, sessionId: id, agent: chosen, agentOverride: override }),
        });
        started.catch(() => {});
        return { ok: true, message: "Asking the model for a summary (one call). It appears in the conversation when it is written." };
      },
      // Takes back the newest turn's file changes. Not while a turn is running:
      // the files are moving.
      undo: async (id) => {
        if ([...running].some((record) => record.session === id)) {
          return { ok: false, message: "A turn is running in this conversation; stop it first." };
        }
        return undoLastTurn({ root: projectRoot, sessionId: id });
      },
      stop: (id) => {
        const mine = [...running].filter((record) => record.session === id);
        for (const record of mine) record.controller.abort();
        return mine.length;
      },
    },
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
      const models = type === "openai-compatible" ? all.filter((model) => module.looksLikeChatModel(model.id)) : all;
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
    startRun({ input, agent, workflow, signal, dryRun, providerFactories, via, session, worktree } = {}) {
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
      const record = { task, agent, startedAt: new Date().toISOString(), controller, done: 0, ...(session ? { session } : {}) };
      const execute = via ?? runProject;
      const started = execute({
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
            if (event.plan) record.plan = event.plan;
            if (event.workflow) record.workflow = event.workflow;
          }
          // Every agent that has run in this run, with who started it — a step
          // names one agent, and an orchestrator hands work to others below it.
          if (event.type === "run.started") {
            record.agents ??= [];
            if (record.agents.length < 40) record.agents.push({ runId: event.runId, parentRunId: event.parentRunId, name: event.agent, status: "working", startedAt: new Date().toISOString(), step: record.step });
          }
          if (event.type === "run.completed" || event.type === "run.failed") {
            const found = record.agents?.find((entry) => entry.runId === event.runId);
            if (found) {
              found.status = event.type === "run.completed" ? "done" : "failed";
              found.finishedAt = new Date().toISOString();
            }
          }
          if (event.type === "workflow.step.started") {
            record.step = event.step;
            record.stepSince = event.at;
            record.stepAgent = undefined;
          }
          if (event.type === "run.started") record.stepAgent = event.agent;
          // What a streaming provider has written so far, for a surface that
          // shows an answer as it forms. Bounded: it is a preview, not the record.
          if (event.type === "agent.delta") record.partial = `${record.partial ?? ""}${event.text}`.slice(-20_000);
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
        ...(worktree === undefined ? {} : { worktree }),
        ...(workflow ? { workflow } : {}),
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
          runErrors.unshift({ task, at: new Date().toISOString(), error: error.message, ...(error.code ? { code: error.code } : {}), ...(agent ? { agent } : {}) });
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
    ...(record.failed ? { failedStep: record.failed, error: record.error } : {}),
  };
}

// A local settings file that the loader refuses must not black out the rest of
// the screen: the surface still shows approvals and runs, and says what is
// wrong with the file.
function settingsUnreadable(error) {
  return { entries: [], layers: [], overrides: [], error: error.message };
}

