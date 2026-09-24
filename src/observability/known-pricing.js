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

// https://platform.openai.com/docs/pricing — this environment cannot reach
// openai.com (network policy), so these are not independently fetched: they
// are what the user read off that page themselves and pasted back, on
// 2026-09-24. Kept only for the rows whose API 'model' id could be inferred
// with confidence from OpenAI's own established naming (the numbered
// releases). The page's other rows — 'GPT-6 Astra', 'GPT-5.6 Sol/Terra/
// Luna', 'Daybreak Blue/Red', 'GPT-Rosalind-Research', 'GPT-5.3-Codex-Spark',
// 'GPT-6 Astra Law' — are the pricing table's display names; nothing here
// says what 'model' string the API actually returns for them, and guessing
// one would defeat the point of this table. Ask for those ids explicitly
// before adding them.
const OPENAI_RATES = Object.freeze({
  "gpt-5.5": { inputPerMillion: 5, cacheReadPerMillion: 0.5, outputPerMillion: 30 },
  "gpt-5.4": { inputPerMillion: 2.5, cacheReadPerMillion: 0.25, outputPerMillion: 15 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 4.5 },
  "gpt-5.3-codex": { inputPerMillion: 1.75, cacheReadPerMillion: 0.175, outputPerMillion: 14 },
  "gpt-5.2": { inputPerMillion: 1.75, cacheReadPerMillion: 0.175, outputPerMillion: 14 },
});

const RATE_TABLES = Object.freeze({
  anthropic: { rates: ANTHROPIC_RATES, asOf: "2026-06-24", source: "https://www.anthropic.com/pricing#api" },
  "openai-compatible": { rates: OPENAI_RATES, asOf: "2026-09-24", source: "https://platform.openai.com/docs/pricing" },
});

// A guessed dollar figure for real spend is worse than none —
// knownPriceFor() says so by name for a model with no entry here, rather
// than silently returning nothing indistinguishable from 'not looked up yet'.
export function knownPriceFor(providerType, modelId) {
  if (typeof modelId !== "string") return undefined;
  const table = RATE_TABLES[providerType];
  if (!table) return undefined;
  // A dated snapshot ('claude-opus-5-2026-09-01') prices the same as the
  // undated name, exactly as observability.pricing itself resolves it.
  const undated = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const rate = table.rates[modelId] ?? table.rates[undated];
  return rate ? { ...rate, asOf: table.asOf, source: table.source } : undefined;
}
