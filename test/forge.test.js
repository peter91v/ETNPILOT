import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { initializeProject } from "../src/config/init.js";
import { forgeProject, summarizeForge, validatePlan } from "../src/forge/forge.js";
import { redactSecrets, surveyRepository } from "../src/forge/survey.js";
import { loadConfig } from "../src/config/load.js";

// AgentsForge reads a repository and asks a model for the agents, skills and
// instructions that fit it. These tests give it a model that answers a fixed
// text, so what is checked is everything around the model: what is sent, what
// is accepted back, and what is written.

async function put(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-forge-"));
  await put(root, {
    "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest", build: "vite build" }, dependencies: { vue: "3" } }),
    "README.md": "# Shop\nA small web shop.\n",
    "src/cart/index.ts": "export const cart = [];\n",
    "src/cart/cart.test.ts": "test('x', () => {});\n",
    "src/api/server.ts": 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\nexport {};\n',
    ".env": "DATABASE_PASSWORD=hunter2hunter2\n",
    // Built at run time: this repository's own secret scan reads test files too.
    "deploy/id_rsa": ["-----BEGIN", "OPENSSH PRIVATE KEY-----\nabc\n-----END", "OPENSSH PRIVATE KEY-----\n"].join(" "),
    "certs/server.pem": "pem\n",
    "node_modules/dep/index.js": "ignored\n",
  });
  return root;
}

const answer = (plan) => async () => ({ text: "```json\n" + JSON.stringify(plan) + "\n```", usage: { inputTokens: 100, outputTokens: 50 } });

const PLAN = {
  agents: [
    { name: "Cart Builder", description: "Changes the cart", tools: ["read_file", "edit_file", "run_command", "fetch_url", "rm_rf"], skills: ["run-tests", "ghost"], prompt: "You work on src/cart." },
    { name: "reviewer", description: "Reads diffs", tools: [], prompt: "You review." },
  ],
  skills: [{ name: "run-tests", description: "How to run the tests", body: "Run `npm test`." }],
  instructions: [
    { name: "layout", body: "Source is under src/." },
    { name: "cart-rules", scope: "src/cart", body: "Cart totals are integers in cents." },
    { name: "escape", scope: "../outside", body: "Not a directory of this repository." },
    { name: "ghost-scope", scope: "does/not/exist", body: "No such directory." },
  ],
};

test("what is sent leaves out credentials and secret-looking text", async () => {
  const root = await repository();
  const survey = await surveyRepository(root);
  assert.match(survey.text, /vitest/);
  assert.match(survey.text, /src\/cart/);
  assert.doesNotMatch(survey.text, /hunter2/);
  assert.doesNotMatch(survey.text, /OPENSSH/);
  assert.doesNotMatch(survey.text, /sk-abcdefgh/);
  assert.match(survey.text, /\[redacted\]/);
  assert.doesNotMatch(survey.text, /node_modules/);
  assert.equal(survey.leftOut, 3); // .env, id_rsa, server.pem
  assert.ok(!survey.included.includes(".env"));
  assert.ok(survey.bytes <= 80 * 1024 + 2048);
  assert.equal(redactSecrets('password = "supersecretvalue"'), 'password = [redacted]');
});

test("the answer is validated: tools are limited, names cleaned, scopes kept inside the repository", async () => {
  const root = await repository();
  const plan = validatePlan(PLAN, { root });
  const builder = plan.agents.find((agent) => agent.name === "cart-builder");
  assert.deepEqual(builder.tools, ["read_file", "edit_file", "run_command"]); // no network, nothing invented
  assert.deepEqual(builder.skills, ["run-tests"]); // the skill it named but never defined is dropped
  assert.deepEqual(plan.agents.find((agent) => agent.name === "reviewer").tools, ["read_file", "list_files", "search_files"]);
  assert.equal(plan.instructions.find((entry) => entry.name === "escape").scope, "");
  assert.throws(() => validatePlan({}, { root }), /nothing/);
  assert.throws(() => validatePlan([], { root }), /object/);
});

test("it writes what is valid, marks it as generated, and never overwrites", async () => {
  const root = await repository();
  await initializeProject(root, { forge: false, importExisting: false });
  await writeFile(join(root, ".etnpilot/agents/reviewer.yaml"), "name: reviewer\npromptRef: mine\n");
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  const report = await forgeProject(root, { config, runModel: answer(PLAN) });

  const builder = YAML.parse(await readFile(join(root, ".etnpilot/agents/cart-builder.yaml"), "utf8"));
  assert.equal(builder.description, "Changes the cart");
  assert.deepEqual(builder.skills, ["run-tests"]);
  assert.ok(builder.tools.includes("load_skill"));
  assert.match(await readFile(join(root, ".etnpilot/agents/cart-builder.yaml"), "utf8"), /^# Forged by AgentsForge/);
  assert.match(await readFile(join(root, ".etnpilot/prompts/cart-builder.md"), "utf8"), /src\/cart/);
  assert.match(await readFile(join(root, ".etnpilot/skills/run-tests/SKILL.md"), "utf8"), /npm test/);
  assert.match(await readFile(join(root, ".etnpilot/instructions/src/cart/forged-cart-rules.md"), "utf8"), /cents/);
  assert.ok((await readdir(join(root, ".etnpilot/instructions"))).includes("forged-layout.md"));
  // The existing reviewer is untouched and reported.
  assert.match(await readFile(join(root, ".etnpilot/agents/reviewer.yaml"), "utf8"), /promptRef: mine/);
  assert.ok(report.skipped.some((entry) => entry.name === "agent reviewer"));
  assert.match(summarizeForge(report).join("\n"), /tokens: 100 in, 50 out/);

  // Running it again adds nothing.
  const again = await forgeProject(root, { config, runModel: answer(PLAN) });
  assert.equal(again.agents.length + again.skills.length + again.instructions.length, 0);
});

test("an answer that cannot be used writes nothing and does not throw", async () => {
  const root = await repository();
  await initializeProject(root, { forge: false, importExisting: false });
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  for (const text of ["I cannot help", "{ not json", JSON.stringify({ agents: [] })]) {
    const report = await forgeProject(root, { config, runModel: async () => ({ text }) });
    assert.equal(report.agents.length, 0);
    assert.match(report.notes.join(" "), /could not be used/);
  }
});

test("a dry run builds the digest and sends nothing", async () => {
  const root = await repository();
  let asked = false;
  const report = await forgeProject(root, { config: {}, dryRun: true, runModel: async () => { asked = true; return { text: "{}" }; } });
  assert.equal(asked, false);
  assert.match(report.digest, /package\.json/);
  assert.ok(report.sent.included.includes("package.json"));
});

test("init forges when asked to, wires the orchestrator to what it made, and survives a failing model", async () => {
  const root = await repository();
  const result = await initializeProject(root, { forge: { runModel: answer(PLAN) }, importExisting: false });
  assert.deepEqual(result.forged.agents.map((entry) => entry.name).sort(), ["cart-builder", "reviewer"]);
  const orchestrator = YAML.parse(await readFile(join(root, ".etnpilot/agents/orchestrator.yaml"), "utf8"));
  assert.deepEqual([...orchestrator.subagents].sort(), ["cart-builder", "reviewer"]);
  assert.ok(orchestrator.tools.includes("spawn_subagent"));
  assert.match(await readFile(join(root, ".etnpilot/prompts/orchestrator.md"), "utf8"), /spawn_subagent/);

  const broken = await repository();
  const survived = await initializeProject(broken, { forge: { runModel: async () => { throw new Error("401 invalid key"); } }, importExisting: false });
  assert.match(survived.forged.notes.join(" "), /AgentsForge failed: 401 invalid key/);
  assert.ok((await readdir(join(broken, ".etnpilot"))).includes("etnpilot.yaml"));
});

test("without a key it says so, and with forge off it does nothing at all", async () => {
  const root = await repository();
  const none = await initializeProject(root, { forge: true, env: {}, importExisting: false });
  assert.match(none.forged.notes.join(" "), /no API key/);
  const off = await initializeProject(await repository(), { forge: false, importExisting: false });
  assert.equal(off.forged, undefined);
});

test("the real provider path: a key is found, tools are off, the digest reaches the model", async () => {
  const root = await repository();
  await initializeProject(root, { forge: false, importExisting: false });
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), { OPENAI_API_KEY: "test-key" });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), auth: options.headers?.authorization ?? options.headers?.Authorization });
    return { ok: true, status: 200, json: async () => ({ model: "gpt-x", choices: [{ message: { content: JSON.stringify(PLAN) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "" };
  };
  config.defaultProvider = "openai";
  const report = await forgeProject(root, { config, env: { OPENAI_API_KEY: "test-key" }, fetchImpl });
  assert.equal(report.provider.name, "openai");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tools, undefined, "this request offers the model no tools");
  assert.match(JSON.stringify(calls[0].body.messages), /vitest/);
  assert.doesNotMatch(JSON.stringify(calls[0].body.messages), /hunter2|sk-abcdefgh/);
  assert.ok(report.agents.length > 0);
});

test("the answer is read as the first complete object, however the model wrapped it", async () => {
  const { parseJson } = await import("../src/forge/forge.js");
  const object = { agents: [{ name: "a", prompt: "use {braces} and \"quotes\" } here" }] };
  const text = JSON.stringify(object);
  assert.deepEqual(parseJson(text), object);
  assert.deepEqual(parseJson(`Here you go:\n${text}\nHope that helps {really}`), object);
  assert.deepEqual(parseJson("```json\n" + text + "\n```\nNotes: {x}"), object);
  assert.deepEqual(parseJson('{"a": [1, 2,], "b": {"c": 1,},}'), { a: [1, 2], b: { c: 1 } });
  assert.throws(() => parseJson(text.slice(0, 40)), /cut off/);
  assert.throws(() => parseJson('{"a": 1 "b": 2}'), /not valid JSON near/);
  assert.throws(() => parseJson("no object"), /no JSON object/);
});

test("when the answer is unusable the model's own text is kept, with the reason it stopped", async () => {
  const root = await repository();
  await initializeProject(root, { forge: false, importExisting: false });
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  const report = await forgeProject(root, { config, runModel: async () => ({ text: '{"agents": [{"name": "a", "prompt": "cut', finish: "length" }) });
  assert.match(report.notes.join(" "), /cut off/);
  assert.match(report.notes.join(" "), /stopped because: length/);
  assert.match(await readFile(join(root, ".etnpilot/state/forge-last-answer.txt"), "utf8"), /"agents"/);
});

test("OpenAI is asked for a JSON object; another server is not sent a field it may refuse", async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ model: "m", choices: [{ message: { content: JSON.stringify(PLAN) }, finish_reason: "stop" }], usage: {} }), text: async () => "" };
  };
  for (const baseUrl of ["https://api.openai.com/v1", "http://127.0.0.1:11434/v1"]) {
    const root = await repository();
    await initializeProject(root, { forge: false, importExisting: false });
    const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
    config.providers.openai.baseUrl = baseUrl;
    config.defaultProvider = "openai";
    await forgeProject(root, { config, env: { OPENAI_API_KEY: "k" }, fetchImpl });
  }
  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.equal(bodies[1].response_format, undefined);
});
