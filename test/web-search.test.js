import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { braveSearch } from "../src/providers/web-search.js";

const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const results = { web: { results: [
  { title: "Node 24", url: "https://nodejs.org/en/blog", description: "<strong>Node</strong> 24 &amp; more", age: "2 days ago" },
  { title: "Second", url: "https://example.org/x", description: "text" },
] } };
const workspace = async (options) => createWorkspaceTools({ workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-search-")), ...options });
const context = (extra = {}) => ({ agent: { name: "researcher" }, approve: async () => ({ kind: "approve-once" }), ...extra });

test("a search returns titles, addresses and clean extracts, and sends the key as a header", async () => {
  let seen;
  const found = await braveSearch({ query: "node lts", count: 2, key: "k-test", fetchImpl: async (url, init) => { seen = { url, init }; return answer(results)(); } });
  assert.equal(found.ok, true);
  assert.equal(found.results.length, 2);
  assert.equal(found.results[0].description, "Node 24 & more");
  assert.match(seen.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=node\+lts&count=2$/);
  assert.equal(seen.init.headers["x-subscription-token"], "k-test");
});

test("no key says how to get one, and a refused key or a rate limit is named", async () => {
  const missing = await braveSearch({ query: "x", env: { ETNPILOT_HOME: await mkdtemp(join(tmpdir(), "etnpilot-nokey-")) }, fetchImpl: answer({}) });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /etnpilot login brave/);
  assert.match((await braveSearch({ query: "x", key: "k", fetchImpl: answer({}, 401) })).error, /refused/);
  assert.match((await braveSearch({ query: "x", key: "k", fetchImpl: answer({}, 429) })).error, /rate limit/);
});

test("the key from the environment is used", async () => {
  let token;
  await braveSearch({ query: "x", env: { BRAVE_SEARCH_API_KEY: "from-env" }, fetchImpl: async (url, init) => { token = init.headers["x-subscription-token"]; return answer(results)(); } });
  assert.equal(token, "from-env");
});

test("web_search asks first, marks the run as having read from outside, and an agent without it does not get it", async () => {
  const asked = [];
  const taints = [];
  const tools = await workspace({ allowed: ["web_search"], searchImpl: async ({ query }) => ({ ok: true, query, results: [] }) });
  assert.deepEqual(tools.definitions.map((definition) => definition.name), ["web_search"]);
  const found = await tools.invoke("web_search", { query: "node lts" }, context({ approve: async (request) => { asked.push(request); return { kind: "approve-once" }; }, taint: (reason) => taints.push(reason) }));
  assert.equal(found.ok, true);
  assert.equal(asked[0].kind, "network");
  assert.equal(taints.length, 1);

  const denied = await tools.invoke("web_search", { query: "x" }, context({ approve: async () => ({ kind: "deny", reason: "no" }) }));
  assert.equal(denied.ok, false);
  assert.equal(denied.approved, false);

  const plain = await workspace({ allowed: ["read_file"] });
  assert.equal(plain.definitions.some((definition) => definition.name === "web_search"), false);
  assert.equal((await tools.invoke("web_search", { query: "" }, context())).ok, false);
});
