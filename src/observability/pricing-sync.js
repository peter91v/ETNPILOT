import { readRegularFile, readResponseBytes } from "../runtime/bounded-io.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { useLearnedRates } from "./known-pricing.js";

// Keeps the table of published prices current without anyone maintaining it.
// Neither Anthropic nor OpenAI publishes prices through an API, but OpenRouter's
// public model catalog lists both vendors' list prices, per token, to anyone
// who asks. A run that meets a model the built-in table does not know therefore
// has a second place to look, refreshed at most once a day and kept in
// '.etnpilot/state/pricing-cache.json'.
//
// What leaves the machine is a plain GET of the public catalog: no prompt, no
// project data, no key. Turning it off is 'observability.pricing.autoUpdate:
// false'. Every failure is silent on purpose — a model that cannot be priced
// reads 'not priced', which is what it would have read anyway.

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function normalizeModelKey(id) {
  return String(id).toLowerCase().replace(/^[a-z0-9-]+\//, "").replace(/\./g, "-").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

// OpenRouter quotes USD per token as strings; the table speaks per million.
export function ratesFromCatalog(catalog) {
  const rates = {};
  if (!Array.isArray(catalog?.data) || catalog.data.length > 10_000) throw new Error("Invalid or oversized price catalog.");
  for (const entry of catalog.data) {
    const input = Number(entry?.pricing?.prompt);
    const output = Number(entry?.pricing?.completion);
    if (!entry?.id || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    const cacheRead = Number(entry.pricing.input_cache_read);
    const cacheWrite = Number(entry.pricing.input_cache_write);
    rates[normalizeModelKey(entry.id)] = {
      inputPerMillion: round(input * 1e6),
      outputPerMillion: round(output * 1e6),
      ...(Number.isFinite(cacheRead) && cacheRead >= 0 && entry.pricing.input_cache_read !== undefined ? { cacheReadPerMillion: round(cacheRead * 1e6) } : {}),
      ...(Number.isFinite(cacheWrite) && cacheWrite >= 0 && entry.pricing.input_cache_write !== undefined ? { cacheWritePerMillion: round(cacheWrite * 1e6) } : {}),
    };
  }
  return rates;
}

export async function refreshPricing({ root, config, fetchImpl = globalThis.fetch, now = Date.now, url = CATALOG_URL, timeoutMs = 3000 } = {}) {
  const pricing = config?.observability?.pricing;
  // On unless switched off, so projects created before the key existed get it
  // too. The test runner is the one place that stays offline by itself; tests
  // of this module pass 'autoUpdate: true' and a fetch of their own.
  const underTest = Boolean(process.env.NODE_TEST_CONTEXT) && pricing?.autoUpdate !== true;
  if (pricing?.autoUpdate === false || underTest || typeof fetchImpl !== "function") { useLearnedRates({}, { root: resolve(root) }); return { used: "none" }; }
  const file = resolve(root, ".etnpilot", "state", "pricing-cache.json");
  const cache = await readRegularFile(file, 4 * 1024 * 1024).then((bytes) => JSON.parse(bytes.toString("utf8"))).catch(() => undefined);
  if (cache?.rates) useLearnedRates(cache.rates, { asOf: cache.fetchedAt, source: cache.source ?? CATALOG_URL, root: resolve(root) });
  const age = cache ? now() - (cache.fetchedAt ?? 0) : Infinity;
  const retryAfter = cache?.failedAt ? now() - cache.failedAt : Infinity;
  if (age < DAY || retryAfter < HOUR) return { used: cache?.rates ? "cache" : "none" };
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
    if (!response?.ok) throw new Error(`catalog answered ${response?.status}`);
    const rates = ratesFromCatalog(JSON.parse((await readResponseBytes(response, 4 * 1024 * 1024, { signal })).bytes.toString("utf8")));
    if (Object.keys(rates).length === 0) throw new Error("catalog held no prices");
    const fetchedAt = now();
    await save(file, { fetchedAt, source: url, rates });
    useLearnedRates(rates, { asOf: fetchedAt, source: url, root: resolve(root) });
    return { used: "network", models: Object.keys(rates).length };
  } catch (error) {
    // Remembered, so an offline phone does not wait for a timeout on every run.
    await save(file, { ...(cache ?? {}), failedAt: now() }).catch(() => undefined);
    return { used: cache?.rates ? "cache" : "none", error: error.message };
  }
}

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
