import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { knownPriceForModel, useLearnedRates } from "../src/observability/known-pricing.js";
import { ratesFromCatalog, refreshPricing } from "../src/observability/pricing-sync.js";

const catalog = {
  data: [
    { id: "openai/gpt-7-nova", pricing: { prompt: "0.000003", completion: "0.000012", input_cache_read: "0.0000003" } },
    { id: "anthropic/claude-opus-9.1", pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "x/free", pricing: { prompt: "-1", completion: "0" } },
  ],
};
const answer = (body, ok = true) => async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });
const config = { observability: { pricing: { autoUpdate: true } } };

test("catalog prices become per-million rates, bad rows are skipped", () => {
  const rates = ratesFromCatalog(catalog);
  assert.deepEqual(rates["gpt-7-nova"], { inputPerMillion: 3, outputPerMillion: 12, cacheReadPerMillion: 0.3 });
  assert.equal(rates["claude-opus-9-1"].outputPerMillion, 25);
  assert.equal(rates.free, undefined);
});

test("a model the table lacks is priced after a refresh, and the built-in table still wins", async () => {
  useLearnedRates({});
  const root = await mkdtemp(join(tmpdir(), "etnpilot-sync-"));
  assert.equal(knownPriceForModel("gpt-7-nova"), undefined);
  const result = await refreshPricing({ root, config, fetchImpl: answer(catalog) });
  assert.equal(result.used, "network");
  assert.equal(knownPriceForModel("gpt-7-nova", { root }).inputPerMillion, 3);
  assert.equal(knownPriceForModel("gpt-7-nova-2026-10-01", { root }).outputPerMillion, 12);
  // Checked by hand beats fetched.
  useLearnedRates({ "gpt-5-4": { inputPerMillion: 999, outputPerMillion: 999 } });
  assert.equal(knownPriceForModel("gpt-5.4").inputPerMillion, 2.5);
  useLearnedRates({});
});

test("the catalog is asked at most once a day, and an offline phone is not retried every run", async () => {
  useLearnedRates({});
  const root = await mkdtemp(join(tmpdir(), "etnpilot-sync-"));
  let calls = 0;
  let clock = 1_000_000;
  const counting = (body, ok) => async (...args) => { calls += 1; return answer(body, ok)(...args); };
  await refreshPricing({ root, config, fetchImpl: counting(catalog, true), now: () => clock });
  clock += 60 * 60 * 1000;
  assert.equal((await refreshPricing({ root, config, fetchImpl: counting(catalog, true), now: () => clock })).used, "cache");
  assert.equal(calls, 1);
  clock += 24 * 60 * 60 * 1000;
  const failing = await refreshPricing({ root, config, fetchImpl: counting({}, false), now: () => clock });
  assert.equal(failing.used, "cache"); // the old cache still serves
  await refreshPricing({ root, config, fetchImpl: counting({}, false), now: () => clock + 1000 });
  assert.equal(calls, 2);
  assert.ok(JSON.parse(await readFile(join(root, ".etnpilot/state/pricing-cache.json"), "utf8")).rates["gpt-7-nova"]);
  useLearnedRates({});
});

test("without autoUpdate nothing is fetched, and a failure never throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-sync-"));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("offline"); };
  assert.equal((await refreshPricing({ root, config: {}, fetchImpl })).used, "none"); // under the test runner
  assert.equal((await refreshPricing({ root, config: { observability: { pricing: { autoUpdate: false } } }, fetchImpl })).used, "none");
  assert.equal(calls, 0);
  const offline = await refreshPricing({ root, config, fetchImpl });
  assert.equal(offline.used, "none");
  assert.equal(calls, 1);
});
