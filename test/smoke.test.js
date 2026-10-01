import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSmoke, runSmoke } from "../src/runtime/smoke.js";

// 'etnpilot smoke' is for a person on a phone with a real key. These tests give
// it an API that behaves like the real one on its good day, and then on bad
// ones, so that what is checked is what the report says about each.

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const streamOf = (text) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const message = (text) => ({ model: "gpt-x", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 3 } });

function goodApi(calls = []) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    if (body.stream) {
      return streamOf(sse([
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "1 2 3 4 5 6 " }],
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "7 8 9 10 11 12" }],
        ["response.completed", { type: "response.completed", response: message("1 2 3 4 5 6 7 8 9 10 11 12") }],
      ]));
    }
    const answered = body.input.find((item) => item.type === "function_call_output");
    if (answered) return json(message(`The file says: ${answered.output}`));
    if (JSON.stringify(body.input).includes("read_file tool")) {
      return json({ model: "gpt-x", output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) }], usage: { input_tokens: 12, output_tokens: 4 } });
    }
    return json(message("pong"));
  };
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-smoke-test-"));
  await writeFile(join(root, "README.md"), "# demo\n");
  const config = {
    defaultProvider: "openai",
    providers: { openai: { type: "openai-compatible", baseUrl: "https://api.openai.test/v1", model: "gpt-x", api: "responses", apiKey: "k" } },
  };
  return { root, config, env: { ETNPILOT_HOME: join(root, "home") } };
}

test("on a good day every step passes, over the API that was asked for", async () => {
  const { root, config, env } = await project();
  const calls = [];
  const report = await runSmoke(root, { config, env, fetchImpl: goodApi(calls) });
  assert.deepEqual(report.steps.map((step) => [step.id, step.status]), [["key", "pass"], ["reply", "pass"], ["tools", "pass"], ["stream", "pass"], ["forge", "pass"]]);
  assert.match(report.steps[1].detail, /gpt-x via responses/);
  assert.match(report.steps[2].detail, /1 tool call/);
  assert.match(report.steps[3].detail, /2 pieces/);
  assert.ok(calls.every((call) => call.url.endsWith("/responses")));
  assert.ok(report.tokens.input > 0);
  const text = formatSmoke(report).join("\n");
  assert.match(text, /✓ reply/);
  assert.match(text, /5\/5 passed against 'openai'/);
});

test("it writes nothing into the project and sends nothing in the forge step", async () => {
  const { root, config, env } = await project();
  const before = await readdir(root);
  const calls = [];
  await runSmoke(root, { config, env, skip: ["reply", "tools", "stream"], fetchImpl: goodApi(calls) });
  assert.deepEqual((await readdir(root)).sort(), before.sort());
  assert.equal(calls.length, 0);
});

test("a refused key says so and says what to do", async () => {
  const { root, config, env } = await project();
  config.providers.openai.baseUrl = "https://api.openai.com/v1";
  const refuse = async () => json({ error: { message: "Incorrect API key provided" } }, 401);
  const report = await runSmoke(root, { config, env, skip: ["key", "forge"], fetchImpl: refuse });
  const reply = report.steps.find((step) => step.id === "reply");
  assert.equal(reply.status, "fail");
  assert.match(reply.hint, /etnpilot login openai/);
  assert.match(formatSmoke(report).join("\n"), /✗ reply[^\n]*\n\s+→ the key was refused/);
});

test("no key at all stops after the first step, with the way out", async () => {
  const { root, config, env } = await project();
  delete config.providers.openai.apiKey;
  const report = await runSmoke(root, { config, env: { ...env, OPENAI_API_KEY: "" }, fetchImpl: goodApi() });
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, "fail");
  assert.match(report.steps[0].detail, /etnpilot login/);
});

test("a model that never calls the tool, or never streams, is reported as that", async () => {
  const { root, config, env } = await project();
  const lazy = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.stream) return streamOf(sse([["response.completed", { type: "response.completed", response: message("1 2 3 4 5 6 7 8 9 10 11 12") }]]));
    return json(message("I know what is in it."));
  };
  const report = await runSmoke(root, { config, env, skip: ["forge"], fetchImpl: lazy });
  const byId = Object.fromEntries(report.steps.map((step) => [step.id, step]));
  assert.equal(byId.reply.status, "fail");
  assert.equal(byId.tools.status, "fail");
  assert.match(byId.tools.detail, /without calling a tool/);
  assert.equal(byId.stream.status, "fail");
  assert.match(byId.stream.detail, /not as a stream/);
});

test("an unknown provider is named", async () => {
  const { root, config, env } = await project();
  const report = await runSmoke(root, { config, env, provider: "nope" });
  assert.match(report.steps[0].detail, /No provider named 'nope'/);
});
