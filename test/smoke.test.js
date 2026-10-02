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
    const finished = body.input.find((item) => item.type === "function_call_output");
    const wantsTool = JSON.stringify(body.input).includes("read_file tool");
    if (body.stream && wantsTool) {
      // The tool loop while streaming: the call comes in the final event, the answer in pieces.
      return finished
        ? streamOf(sse([
          ["response.output_text.delta", { type: "response.output_text.delta", delta: "The file says: " }],
          ["response.output_text.delta", { type: "response.output_text.delta", delta: finished.output }],
          ["response.completed", { type: "response.completed", response: message(`The file says: ${finished.output}`) }],
        ]))
        : streamOf(sse([["response.completed", { type: "response.completed", response: { model: "gpt-x", output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) }], usage: { input_tokens: 12, output_tokens: 4 } } }]]));
    }
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
  assert.deepEqual(report.steps.map((step) => [step.id, step.status]), [["key", "pass"], ["reply", "pass"], ["tools", "pass"], ["stream", "pass"], ["toolstream", "pass"], ["forge", "pass"]]);
  assert.match(report.steps[1].detail, /gpt-x via responses/);
  assert.match(report.steps[2].detail, /1 tool call/);
  assert.match(report.steps[3].detail, /2 pieces/);
  assert.ok(calls.every((call) => call.url.endsWith("/responses")));
  assert.ok(report.tokens.input > 0);
  const text = formatSmoke(report).join("\n");
  assert.match(text, /✓ reply/);
  // The longest step name still has a space before its detail.
  assert.match(text, /✓ toolstream \S/);
  assert.match(text, /6\/6 passed against 'openai'/);
});

test("it writes nothing into the project and sends nothing in the forge step", async () => {
  const { root, config, env } = await project();
  const before = await readdir(root);
  const calls = [];
  await runSmoke(root, { config, env, skip: ["reply", "tools", "stream", "toolstream"], fetchImpl: goodApi(calls) });
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
  assert.equal(byId.toolstream.status, "fail");
  assert.match(byId.toolstream.detail, /without calling a tool/);
});

test("an unknown provider is named", async () => {
  const { root, config, env } = await project();
  const report = await runSmoke(root, { config, env, provider: "nope" });
  assert.match(report.steps[0].detail, /No provider named 'nope'/);
});

test("doctor warns about what does not stop a run", async () => {
  const { diagnose } = await import("../src/runtime/diagnose.js");
  const { root } = await project();
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(join(root, ".etnpilot"), { recursive: true });
  await write(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\nproviders: {}\n");
  const report = await diagnose(root);
  const text = (report.warnings ?? []).join("\n");
  assert.match(text, /Receipts are not signed/);
  assert.match(text, /sandbox\.enabled is false/);
});

test("--gitlab reads who the token is and that the project can be seen, and writes nothing", async () => {
  const { root, config, env } = await project();
  config.git = { baseUrl: "https://git.example.test", project: "team/app" };
  const calls = [];
  const gitlabApi = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/api/v4/user")) return json({ username: "peter" });
    if (String(url).includes("/projects/team%2Fapp")) return json({ path_with_namespace: "team/app", default_branch: "main" });
    return json({}, 404);
  };
  const withToken = { ...env, ETNPILOT_GITLAB_TOKEN: ["glpat", "test", "not", "a", "real", "token", "value"].join("-") };
  const report = await runSmoke(root, { config, env: withToken, skip: ["key", "reply", "tools", "stream", "toolstream", "forge"], gitlab: true, fetchImpl: gitlabApi });
  const step = report.steps.find((entry) => entry.id === "gitlab");
  assert.equal(step.status, "pass");
  assert.match(step.detail, /signed in as peter, project team\/app is visible/);
  assert.ok(calls.every((call) => call.method === "GET"));
  // Not part of an ordinary run.
  const plain = await runSmoke(root, { config, env: withToken, skip: ["key", "reply", "tools", "stream", "toolstream", "forge"], fetchImpl: gitlabApi });
  assert.equal(plain.steps.some((entry) => entry.id === "gitlab"), false);
});

// A cost nobody can find is the worst kind. Every request the check makes goes
// into the usage record, and the totals there are the totals the report shows.
test("the requests of a smoke check are in the usage record, token for token", async () => {
  const { summarizeTelemetryFile } = await import("../src/observability/telemetry.js");
  const { root, config, env } = await project();
  const withUsage = { ...config, observability: { enabled: true, file: ".etnpilot/state/telemetry.jsonl" } };
  const report = await runSmoke(root, { config: withUsage, env, skip: ["forge"], fetchImpl: goodApi() });
  assert.equal(report.usageRecorded, true);
  const recorded = await summarizeTelemetryFile(join(root, ".etnpilot", "state", "telemetry.jsonl"), { root, config: withUsage });
  assert.equal(recorded.inputTokens, report.tokens.input);
  assert.equal(recorded.outputTokens, report.tokens.output);
  assert.ok(recorded.invocations >= 4, "reply, tools, stream and toolstream each recorded");
  assert.match(formatSmoke(report).join("\n"), /Recorded in the usage report/);
});

test("with observability off the check says its cost is not recorded", async () => {
  const { root, config, env } = await project();
  const report = await runSmoke(root, { config: { ...config, observability: { enabled: false } }, env, skip: ["forge"], fetchImpl: goodApi() });
  assert.equal(report.usageRecorded, false);
  assert.match(formatSmoke(report).join("\n"), /Not recorded: observability is off/);
});

test("the Copilot provider is checked for its SDK and an answer; tools and streaming do not apply to it", async () => {
  const { root, env } = await project();
  const config = { defaultProvider: "github-copilot", providers: { "github-copilot": { type: "github-copilot" } } };
  const factories = { "github-copilot": async (name) => ({ name, capabilities: ["chat"], invoke: async () => ({ text: "pong", model: "copilot-x", usage: { inputTokens: 5, outputTokens: 1 } }) }) };
  const report = await runSmoke(root, { config, env, provider: "github-copilot", skip: ["forge"], factories, sdkImporter: async () => ({}) });
  assert.deepEqual(report.steps.map((step) => `${step.id}:${step.status}`), ["key:pass", "reply:pass", "tools:skip", "stream:skip", "toolstream:skip", "forge:skip"]);
  assert.match(report.steps[0].detail, /SDK installed/);
});

test("without the Copilot SDK the first step says what to do, and nothing else is tried", async () => {
  const { root, env } = await project();
  const config = { defaultProvider: "github-copilot", providers: { "github-copilot": { type: "github-copilot" } } };
  const report = await runSmoke(root, { config, env, provider: "github-copilot", sdkImporter: async () => { throw new Error("not found"); } });
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, "fail");
  assert.match(report.steps[0].detail, /Copilot SDK is not available/);
  assert.match(report.steps[0].hint, /npm install @github\/copilot-sdk/);
});

test("--gitlab-write uses the project's own GitLab login, writes only into a project named for it, and removes what it made", async () => {
  const { root, config, env } = await project();
  config.git = { baseUrl: "https://git.example.test", project: "team/etnpilot-smoke" };
  const calls = [];
  const gitlabApi = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const path = new URL(String(url)).pathname.replace("/api/v4", "");
    calls.push(`${method} ${path}`);
    if (path === "/projects/team%2Fetnpilot-smoke" && method === "GET") return json({ id: 7, path: "etnpilot-smoke", default_branch: "main" });
    if (path.endsWith("/repository/branches") && method === "POST") return json({ name: "b" });
    if (path.endsWith("/repository/commits")) return json({ id: "abc" });
    if (path.endsWith("/merge_requests") && method === "POST") return json({ iid: 3, draft: true, title: "Draft: x" });
    if (path.endsWith("/approvals")) return json({ approved: false });
    if (path.endsWith("/pipelines")) return json([{ status: "success" }]);
    if (path.endsWith("/merge_requests/3") && method === "PUT") return json({ state: "closed" });
    if (path.includes("/repository/branches/") && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  };
  const withToken = { ...env, ETNPILOT_GITLAB_TOKEN: ["glpat", "test", "not", "a", "real", "token", "value"].join("-") };
  const skip = ["key", "reply", "tools", "stream", "toolstream", "forge"];
  const report = await runSmoke(root, { config, env: withToken, skip, gitlabWrite: true, fetchImpl: gitlabApi, gitlabPipelineMs: 0 });
  const step = report.steps.find((entry) => entry.id === "gitlab-write");
  assert.equal(step.status, "pass", step.detail);
  assert.match(step.detail, /created and removed again/);
  assert.ok(calls.some((call) => call.startsWith("PUT ")) && calls.some((call) => call.startsWith("DELETE ")), "it closed the MR and deleted the branch");

  // Not part of an ordinary run, and refused for a project that is not named for it.
  assert.equal((await runSmoke(root, { config, env: withToken, skip, fetchImpl: gitlabApi })).steps.some((entry) => entry.id === "gitlab-write"), false);
  const real = { ...config, git: { baseUrl: "https://git.example.test", project: "team/app" } };
  const refused = await runSmoke(root, { config: real, env: withToken, skip, gitlabWrite: true, fetchImpl: async (url, options = {}) => (options.method ?? "GET") === "GET" ? json({ id: 1, path: "app", default_branch: "main" }) : json({}, 500) });
  assert.equal(refused.steps.find((entry) => entry.id === "gitlab-write").status, "fail");
  assert.match(refused.steps.find((entry) => entry.id === "gitlab-write").detail, /etnpilot-smoke/);
});
