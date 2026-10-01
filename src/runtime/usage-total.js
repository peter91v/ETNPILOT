// @ts-check
// What a run has used so far, added up from the agents that have finished in
// it. A running card shows this while the receipt (which has the exact figure)
// is not sealed yet; it is a floor, because the agent that is working now has
// not reported.

export function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const next = {
    inputTokens: (total?.inputTokens ?? 0) + (Number(usage.inputTokens) || 0),
    outputTokens: (total?.outputTokens ?? 0) + (Number(usage.outputTokens) || 0),
    agents: (total?.agents ?? 0) + 1,
  };
  const cost = typeof usage.estimatedCost === "number" ? usage.estimatedCost : undefined;
  if (cost !== undefined || total?.estimatedCost !== undefined) {
    next.estimatedCost = (total?.estimatedCost ?? 0) + (cost ?? 0);
    next.currency = total?.currency ?? usage.currency;
  }
  // Some call reported no price: the sum is less than what was spent.
  if (cost === undefined || total?.unpriced) next.unpriced = true;
  return next;
}
