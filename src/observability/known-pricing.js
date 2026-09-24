// A snapshot of published per-token rates, for filling in
// 'observability.pricing.models' without retyping them — never a live
// source, because neither Anthropic nor OpenAI publishes prices through an
// API. Every entry says which provider's own pricing page it came from and
// when it was last checked against it; treat the date as this table's
// expiry, not a guarantee. A model with no entry here is not evidence it is
// unpriced — it means this table was never updated for it, and the settings
// view says exactly that rather than silently entering nothing.
//
// Rates are USD per million tokens. 'cacheReadPerMillion' defaults to
// 'inputPerMillion' where a provider does not discount cache reads.

// https://www.anthropic.com/pricing#api — checked 2026-06-24 (see the
// claude-api skill's own cached model table, same source and date).
const ANTHROPIC_RATES = Object.freeze({
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
});

// No OpenAI table: this project has no source for OpenAI's rates that it can
// stand behind the way it can for Anthropic's own published list above.
// Shipping guessed dollar figures for real spend is worse than shipping
// none — knownPriceFor() says so by name for an OpenAI model, rather than
// silently returning nothing indistinguishable from 'not looked up yet'.
export function knownPriceFor(providerType, modelId) {
  if (typeof modelId !== "string") return undefined;
  if (providerType !== "anthropic") return undefined;
  // A dated snapshot ('claude-opus-5-2026-09-01') prices the same as the
  // undated name, exactly as observability.pricing itself resolves it.
  const undated = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const rate = ANTHROPIC_RATES[modelId] ?? ANTHROPIC_RATES[undated];
  return rate ? { ...rate, asOf: "2026-06-24", source: "https://www.anthropic.com/pricing#api" } : undefined;
}
