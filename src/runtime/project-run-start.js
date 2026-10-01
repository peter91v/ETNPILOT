// @ts-check
import { createInboxApprovalHandler } from "../core/approval-inbox.js";
import { createApprovalNotifier } from "../core/approval-notify.js";
import { runProject } from "./project-runner.js";
import { addUsage } from "./usage-total.js";

// Starting a run from a surface, and keeping track of it while it works.
// `scope` is what the state shares with it: project root, environment, the
// inbox, the runs being tracked and the errors of those that failed.
export function startProjectRun(scope, { input, agent, workflow, signal, dryRun, providerFactories, via, session, worktree } = /** @type {any} */ ({})) {
  const { projectRoot, env, inbox, running, runErrors } = scope;
  if (!input || !String(input).trim()) throw new TypeError("A task is required to start a run.");
  const inboxConfig = scope.config.approval?.inbox ?? {};
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
  const record = /** @type {any} */ ({ task, agent, startedAt: new Date().toISOString(), controller, done: 0, ...(session ? { session } : {}) });
  const execute = via ?? runProject;
  const started = execute({
    root: projectRoot,
    env,
    input: task,
    agent,
    signal: controller.signal,
    // Where the run is, so a surface can say more than 'working'.
    onEvent: (event) => trackRunEvent(record, event),
    dryRun,
    providerFactories,
    ...(worktree === undefined ? {} : { worktree }),
    ...(workflow ? { workflow } : {}),
    approvalHandler: createInboxApprovalHandler({
      inbox,
      timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
      pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
      notifier: createApprovalNotifier(scope.config.approval?.notify),
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
}

// Where the run is, so a surface can say more than 'working'.
export function trackRunEvent(record, event) {
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
      record.usage = addUsage(record.usage, event.usage);
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
}
