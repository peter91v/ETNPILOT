import { ProviderError } from "./router.js";

export function invocationMeter(context, provider) {
  let previous = {};
  let accounting;
  let cost;
  let streamed = false;
  const progress = (usage = {}, model = context.agent.model) => {
    streamed = true;
    const delta = {};
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "providerUnits", "requests"]) {
      delta[key] = Math.max(0, (usage[key] ?? 0) - (previous[key] ?? 0));
    }
    delta.usageStatus = usage.usageStatus;
    previous = { ...usage };
    const next = context.telemetry?.recordProviderUsage({ workflowRunId: context.metadata?.workflowRunId,
      agentRunId: context.runId, provider, model, usage: delta, invocationComplete: false });
    if (next) {
      if (next.estimatedCost !== undefined) cost = (cost ?? 0) + next.estimatedCost;
      accounting = { ...next, ...(next.pricing ? {} : accounting?.pricing ? { pricing: accounting.pricing } : {}), ...usage, ...(cost === undefined ? {} : { estimatedCost: cost }), usageStatus: usage.usageStatus ?? "measured" };
      if (next.budgetExceeded) {
        const error = new ProviderError("Workflow usage budget exceeded.", { code: "budget_exceeded" });
        error.budget = next.budgetExceeded; error.accounting = accounting;
        throw error;
      }
    }
    return accounting;
  };
  return {
    context: { ...context, recordProviderProgress: progress, beforeProviderRequest: () => {
      const limit = context.telemetry?.budgets.maxProviderRequestsPerWorkflow;
      const total = context.telemetry?.summary(context.metadata?.workflowRunId ?? context.runId);
      if (limit !== undefined && total.requests >= limit) throw new ProviderError("Workflow provider-request budget exceeded.", { code: "budget_exceeded" });
    } },
    finish(result, error) {
      if (!streamed) progress(result?.usage ?? error?.usage ?? { usageStatus: "unknown" }, result?.model ?? error?.model);
      const completed = context.telemetry?.recordProviderUsage({ workflowRunId: context.metadata?.workflowRunId,
        agentRunId: context.runId, provider, model: accounting?.model ?? result?.model ?? context.agent.model,
        usage: { usageStatus: accounting?.usageStatus ?? "unknown" }, invocationComplete: true });
      if (accounting && completed) accounting = { ...accounting, workflow: completed.workflow };
      if (error && accounting) error.accounting = accounting;
      return accounting;
    },
  };
}

// Streaming reports cumulative counters within one HTTP attempt. Price deltas
// immediately, but merge those counters into invocation usage exactly once.
export async function accountRequest(context, usage, model, addUsage, execute) {
  context.signal?.throwIfAborted();
  context.beforeProviderRequest?.();
  usage.requests += 1;
  usage.usageStatus = "partial";
  context.recordProviderProgress?.(usage, model);
  const base = { ...usage };
  let partial;
  const requestContext = { ...context, onStreamUsage: (raw, responseModel) => {
    partial = raw;
    const snapshot = { ...base };
    addUsage(snapshot, raw);
    snapshot.usageStatus = "partial";
    context.recordProviderProgress?.(snapshot, responseModel ?? model);
  } };
  try { return await execute(requestContext); }
  catch (error) {
    if (partial) {
      addUsage(usage, partial);
      usage.usageStatus = "partial";
      context.recordProviderProgress?.(usage, model);
    }
    throw error;
  }
}
