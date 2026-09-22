export class WorkflowEngine {
  constructor({ concurrency = 1, failFast = true, timeoutMs = 30 * 60_000, maxSteps = 100, events } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer.");
    this.concurrency = concurrency;
    this.failFast = failFast;
    this.timeoutMs = timeoutMs;
    this.maxSteps = maxSteps;
    this.events = events;
  }

  async run(steps, execute, { signal, context = {} } = {}) {
    const normalized = validateSteps(steps, this.maxSteps);
    const states = new Map(normalized.map((step) => [step.id, {
      id: step.id,
      status: "pending",
      attempts: 0,
    }]));
    const results = new Map();
    const running = new Map();
    let fatalError;

    while ([...states.values()].some((state) => state.status === "pending" || state.status === "running")) {
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow aborted.");

      for (const step of normalized) {
        const state = states.get(step.id);
        if (state.status !== "pending") continue;
        const dependencyStates = step.needs.map((id) => states.get(id));
        if (dependencyStates.some((dependency) => ["failed", "blocked"].includes(dependency.status))) {
          state.status = "blocked";
          state.reason = "dependency-failed";
          await this.events?.emit("workflow.step.blocked", { step: step.id });
        }
      }

      if (fatalError && this.failFast) {
        for (const state of states.values()) {
          if (state.status === "pending") {
            state.status = "blocked";
            state.reason = "fail-fast";
          }
        }
      }

      const ready = normalized.filter((step) => {
        const state = states.get(step.id);
        return state.status === "pending"
          && step.needs.every((id) => states.get(id).status === "succeeded");
      });

      while (ready.length > 0 && running.size < this.concurrency && !(fatalError && this.failFast)) {
        const step = ready.shift();
        const state = states.get(step.id);
        state.status = "running";
        state.startedAt = new Date().toISOString();
        const dependencyResults = Object.fromEntries(step.needs.map((id) => [id, results.get(id)]));
        await this.events?.emit("workflow.step.started", { step: step.id });
        const promise = executeWithRetry(step, execute, {
          context,
          dependencyResults,
          signal,
          defaultTimeoutMs: this.timeoutMs,
          onAttempt: (attempt) => { state.attempts = attempt; },
        }).then(async (result) => {
          state.status = "succeeded";
          state.finishedAt = new Date().toISOString();
          state.result = result;
          results.set(step.id, result);
          await this.events?.emit("workflow.step.completed", { step: step.id, attempts: state.attempts });
        }).catch(async (error) => {
          state.status = "failed";
          state.finishedAt = new Date().toISOString();
          state.error = error instanceof Error ? error.message : String(error);
          fatalError ??= error;
          await this.events?.emit("workflow.step.failed", { step: step.id, error: state.error });
        }).finally(() => running.delete(step.id));
        running.set(step.id, promise);
      }

      if (running.size > 0) await Promise.race(running.values());
      else if ([...states.values()].some((state) => state.status === "pending")) {
        throw new Error("Workflow stalled without runnable steps.");
      }
    }

    const summary = {
      status: [...states.values()].some((state) => state.status === "failed") ? "failed" : "succeeded",
      steps: Object.fromEntries([...states].map(([id, state]) => [id, state])),
    };
    if (fatalError && this.failFast) {
      fatalError.workflow = summary;
      throw fatalError;
    }
    return summary;
  }
}

function validateSteps(steps, maxSteps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError("Workflow requires at least one step.");
  if (steps.length > maxSteps) throw new Error(`Workflow exceeds the ${maxSteps}-step budget.`);
  const ids = new Set();
  const normalized = steps.map((step) => {
    if (!step?.id || typeof step.id !== "string") throw new TypeError("Every workflow step requires an id.");
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step: '${step.id}'.`);
    ids.add(step.id);
    return { retries: 0, needs: [], ...step, needs: [...(step.needs ?? [])] };
  });
  for (const step of normalized) {
    for (const dependency of step.needs) {
      if (!ids.has(dependency)) throw new Error(`Step '${step.id}' needs unknown step '${dependency}'.`);
      if (dependency === step.id) throw new Error(`Step '${step.id}' cannot depend on itself.`);
    }
  }
  assertAcyclic(normalized);
  return normalized;
}

function assertAcyclic(steps) {
  const indegree = new Map(steps.map((step) => [step.id, step.needs.length]));
  const queue = steps.filter((step) => step.needs.length === 0).map((step) => step.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const step of steps) {
      if (!step.needs.includes(id)) continue;
      const next = indegree.get(step.id) - 1;
      indegree.set(step.id, next);
      if (next === 0) queue.push(step.id);
    }
  }
  if (visited !== steps.length) throw new Error("Workflow contains a dependency cycle.");
}

async function executeWithRetry(step, execute, options) {
  const retries = Number.isInteger(step.retries) && step.retries >= 0 ? step.retries : 0;
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    options.onAttempt(attempt);
    try {
      return await withTimeout(
        (signal) => execute(step, { ...options, signal, attempt }),
        step.timeoutMs ?? options.defaultTimeoutMs,
        options.signal,
        `Step '${step.id}' timed out.`,
      );
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
    }
  }
  throw lastError;
}

async function withTimeout(operation, timeoutMs, parentSignal, message) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(message)), timeoutMs)
    : undefined;
  try {
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(controller.signal.reason ?? new Error(message));
      }, { once: true });
    });
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}
