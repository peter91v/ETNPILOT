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
// 2026-09-24. Rows whose API id is not confirmed are marked inside.
const OPENAI_RATES = Object.freeze({
  // OpenAI's published launch rates for the GPT-5 family (August 2025). Dated
  // snapshots ('gpt-5-mini-2025-08-07') price as the undated name.
  "gpt-5": { inputPerMillion: 1.25, cacheReadPerMillion: 0.125, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, cacheReadPerMillion: 0.025, outputPerMillion: 2 },
  "gpt-5-nano": { inputPerMillion: 0.05, cacheReadPerMillion: 0.005, outputPerMillion: 0.4 },
  "gpt-5.5": { inputPerMillion: 5, cacheReadPerMillion: 0.5, outputPerMillion: 30 },
  "gpt-5.4": { inputPerMillion: 2.5, cacheReadPerMillion: 0.25, outputPerMillion: 15 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 4.5 },
  "gpt-5.3-codex": { inputPerMillion: 1.75, cacheReadPerMillion: 0.175, outputPerMillion: 14 },
  "gpt-5.2": { inputPerMillion: 1.75, cacheReadPerMillion: 0.175, outputPerMillion: 14 },
  // The one non-numbered row whose API id is known, because a real run
  // returned it: the page lists it as 'GPT-5.6 Luna' (0.20 / 0.02 / 1.20),
  // the API answered 'gpt-6-luna'. That mismatch is exactly why the other
  // display names stay out until their ids are seen the same way.
  "gpt-6-luna": { inputPerMillion: 0.2, cacheReadPerMillion: 0.02, outputPerMillion: 1.2 },
  // The rest of the page, keyed by the id its display name most plausibly
  // has. None of these ids has been seen in a real response yet (Luna's
  // page name and API id already differ), so the 5.6 family is listed under
  // the page-name id and under the 'gpt-6-' form Luna actually answered
  // with. A wrong id costs nothing: the row is never matched and the model
  // reads 'not priced'. Correct the keys as real runs show the ids.
  "gpt-6-astra": { inputPerMillion: 10, cacheReadPerMillion: 1, outputPerMillion: 50 },
  "gpt-6-astra-law": { inputPerMillion: 12.5, cacheReadPerMillion: 1.25, outputPerMillion: 62.5 },
  "gpt-5.6-sol": { inputPerMillion: 4, cacheReadPerMillion: 0.4, outputPerMillion: 20 },
  "gpt-6-sol": { inputPerMillion: 4, cacheReadPerMillion: 0.4, outputPerMillion: 20 },
  "gpt-5.6-terra": { inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 12 },
  "gpt-6-terra": { inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 12 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, cacheReadPerMillion: 0.02, outputPerMillion: 1.2 },
  "gpt-rosalind-research": { inputPerMillion: 5, cacheReadPerMillion: 0.5, outputPerMillion: 25 },
  "daybreak-blue": { inputPerMillion: 4, cacheReadPerMillion: 0.4, outputPerMillion: 20 },
  "daybreak-red": { inputPerMillion: 12.5, cacheReadPerMillion: 1.25, outputPerMillion: 75 },
  // 'GPT-5.3-Codex-Spark' is a research preview without published rates: left out.
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

// The same lookup when only the model id is at hand (telemetry records the
// provider's configured name, not its type). Ids do not collide across the
// tables — 'claude-…' versus 'gpt-…' — so the first table that knows the id
// answers. Undefined when none does.
export function knownPriceForModel(modelId) {
  for (const type of Object.keys(RATE_TABLES)) {
    const rate = knownPriceFor(type, modelId);
    if (rate) return rate;
  }
  return learnedPriceFor(modelId);
}

// Rates the project learned from the public catalog (see pricing-sync.js).
// They answer only for what the built-in table does not know, so a rate that
// was checked by hand is never replaced by a fetched one.
let learned = { rates: {}, asOf: undefined, source: undefined };

export function useLearnedRates(rates, { asOf, source } = {}) {
  learned = { rates: rates ?? {}, asOf, source };
}

function learnedPriceFor(modelId) {
  if (typeof modelId !== "string") return undefined;
  const key = modelId.toLowerCase().replace(/^[a-z0-9-]+\//, "").replace(/\./g, "-").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const rate = learned.rates[key];
  return rate ? { ...rate, asOf: learned.asOf, source: learned.source } : undefined;
}
