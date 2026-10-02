import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderChatMarkdown } from "../src/ui/markdown.js";
import { runGitLabSmoke } from "../src/gitlab/smoke.js";
import { verifyReceiptFile } from "../src/core/receipt-store.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createMcpClient } from "../src/providers/mcp-client.js";
import { Telemetry } from "../src/observability/telemetry.js";
import { invocationMeter } from "../src/providers/usage-meter.js";
import { runChild } from "../src/runtime/child-process.js";
import { acquireWorkspaceLease, recoverWorkspaceLease } from "../src/runtime/workspace-lease.js";

const temporary = () => mkdtemp(join(tmpdir(), "etnpilot-review-integration-"));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const context = () => ({ runId: "r", input: "go", instructions: [], agent: { name: "builder", model: "m" }, approve: async () => ({ kind: "approve-once" }) });

class Node {
  constructor(tag, text = "") { this.tag = tag; this.value = text; this.attributes = {}; this.children = []; }
  append(node) { this.children.push(node); }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = value; }
  set innerHTML(_) { throw new Error("Raw HTML is forbidden."); }
}
const document = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Node("text", text) };
const descendants = (node) => [node, ...node.children.flatMap(descendants)];

test("Markdown renders text, formatting and safe links without HTML or dangerous URLs", () => {
  const rendered = renderChatMarkdown('# Title\n**strong** *em* `code`\n[good](https://example.invalid) [bad](javascript:alert)\n<img src=x onerror=alert>\n```js\n<script>data</script>\n```', document);
  const nodes = descendants(rendered);
  assert.ok(nodes.some((node) => node.tag === "strong" && node.textContent === "strong"));
  assert.ok(nodes.some((node) => node.tag === "pre" && node.textContent.includes("<script>data</script>")));
  assert.ok(rendered.textContent.includes("<img src=x onerror=alert>"));
  assert.deepEqual(nodes.filter((node) => node.tag === "a").map((node) => node.attributes.href), ["https://example.invalid"]);
  assert.ok(nodes.every((node) => !["script", "img"].includes(node.tag)));
  const huge = renderChatMarkdown("**a** ".repeat(10000), document); assert.ok(descendants(huge).length < 5000);
});

function smokeClient({ failCommit = false, failCleanup = false } = {}) {
  const operations = [];
  return {
    operations,
    project: async () => ({ id: 1, path: "etnpilot-smoke", default_branch: "main" }),
    createBranch: async () => { operations.push("branch"); },
    createMergeRequest: async () => { operations.push("mr"); return { iid: 2, draft: true }; },
    mergeRequestApprovals: async () => ({}), pipelines: async () => [{ status: "success" }],
    request: async (method, path) => {
      operations.push(method);
      if (method === "POST" && failCommit) throw new Error("commit failed");
      if (method === "DELETE" && failCleanup) throw new Error("cleanup failed");
      return { id: "fixture-sha" };
    },
  };
}

test("GitLab smoke is opt-in, verifies evidence and always cleans its own MR/branch", async () => {
  const root = await temporary(); const client = smokeClient();
  await assert.rejects(runGitLabSmoke({ client, project: 1 }), /explicit confirmation/); assert.equal(client.operations.length, 0);
  const path = join(root, "success.jsonl"); const report = await runGitLabSmoke({ client, project: 1, receiptPath: path, confirmWrites: true });
  assert.equal(report.receiptVerified, true); assert.equal(report.pipelineVerified, true); assert.equal(report.cleaned, true);
  assert.deepEqual(client.operations, ["branch", "POST", "mr", "PUT", "DELETE"]);
  assert.equal((await verifyReceiptFile(path, { requireTerminal: true })).valid, true);
  const failing = smokeClient({ failCommit: true });
  await assert.rejects(runGitLabSmoke({ client: failing, project: 1, receiptPath: join(root, "failure.jsonl"), confirmWrites: true }), /commit failed/);
  assert.deepEqual(failing.operations, ["branch", "POST", "DELETE"]);
  await assert.rejects(runGitLabSmoke({ client: smokeClient({ failCleanup: true }), project: 1, receiptPath: join(root, "cleanup.jsonl"), confirmWrites: true }), /cleanup failed/);
});

for (const type of ["openai", "anthropic"]) test(`${type} qualified MCP tool names round-trip through actual provider schemas`, async () => {
  const root = await temporary(); let invoked = 0; let requests = 0;
  const tool = { definition: { name: "codegraph.codegraph_explore", description: "fixture", parameters: { type: "object", properties: {} } }, invoke: async () => { invoked += 1; return { ok: true, content: "graph" }; } };
  const factory = type === "openai" ? createOpenAICompatibleProvider : createAnthropicProvider;
  const provider = factory({ apiKey: "fixture", baseUrl: "https://example.invalid", tools: true, workingDirectory: root, extraTools: [tool], fetchImpl: async (_, options) => {
    requests += 1; const body = JSON.parse(options.body); const name = type === "openai" ? body.tools[0].function.name : body.tools[0].name;
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    if (type === "openai") return response({ usage: { prompt_tokens: 1 }, choices: [{ message: requests === 1 ? { tool_calls: [{ id: "t", function: { name, arguments: "{}" } }] } : { content: "done" } }] });
    return response({ usage: { input_tokens: 1 }, content: requests === 1 ? [{ type: "tool_use", id: "t", name, input: {} }] : [{ type: "text", text: "done" }] });
  } });
  const result = await provider.invoke({ ...context(), agent: { name: "builder", tools: [tool.definition.name] } });
  assert.equal(invoked, 1); assert.equal(result.text, "done"); assert.equal(result.toolCalls[0].tool, tool.definition.name);
});

const silentServer = `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');});process.on('SIGTERM',()=>{});`;
test("MCP pending request bounds and abort settle calls and kill an uncooperative server", async () => {
  const client = createMcpClient({ name: "silent", command: process.execPath, args: ["-e", silentServer], limits: { maxPendingRequests: 1, shutdownTimeoutMs: 50 }, timeoutMs: 2000 });
  try {
    await client.initialize(); const abort = new AbortController();
    const outstanding = client.callTool("hold", {}, { signal: abort.signal });
    const rejected = assert.rejects(outstanding, /stop call/);
    await assert.rejects(client.callTool("another", {}), /pending-request limit/);
    abort.abort(new Error("stop call")); await rejected; await client.close();
    await assert.rejects(client.callTool("hold", {}), /not running/);
  } finally { await client.close(); }
});

test("HTTP retries count actual requests and a request budget blocks before submission", async () => {
  let calls = 0; const provider = createOpenAICompatibleProvider({ apiKey: "fixture", baseUrl: "https://example.invalid", retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 }, fetchImpl: async () => {
    calls += 1; return calls % 2 ? response({ error: { message: "rate limit" } }, 429) : response({ usage: { prompt_tokens: 10 }, choices: [{ message: { content: "done" } }] });
  } });
  const telemetry = new Telemetry(); const meter = invocationMeter({ ...context(), telemetry }, "p");
  const result = await provider.invoke(meter.context); meter.finish(result);
  assert.equal(result.usage.requests, 2); assert.equal(result.usage.usageStatus, "partial"); assert.equal(telemetry.summary("r").requests, 2);
  calls = 0; const bounded = new Telemetry({ budgets: { maxProviderRequestsPerWorkflow: 1 } }); const gate = invocationMeter({ ...context(), telemetry: bounded }, "p");
  await assert.rejects(provider.invoke(gate.context), /provider-request budget exceeded/);
  assert.equal(calls, 1); assert.equal(bounded.summary("r").requests, 1);
});

test("stream failure retains usage reported before interruption", async () => {
  const stream = 'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"stop"}}\n\n';
  const provider = createAnthropicProvider({ apiKey: "fixture", stream: true, retry: { attempts: 1 }, fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  const telemetry = new Telemetry(); const meter = invocationMeter({ ...context(), telemetry }, "anthropic");
  let failure; try { await provider.invoke(meter.context); } catch (error) { failure = error; meter.finish(undefined, error); }
  assert.equal(failure.usage.inputTokens, 15); assert.equal(failure.usage.cacheReadTokens, 5); assert.equal(telemetry.summary("r").inputTokens, 15);
});

test("leases reject another process and leave a crash lease for explicit recovery", async () => {
  const root = await temporary(); const module = new URL("../src/runtime/workspace-lease.js", import.meta.url).href;
  const lease = await acquireWorkspaceLease(root);
  try {
    const result = await runChild([process.execPath, "--input-type=module", "-e", `import {acquireWorkspaceLease} from ${JSON.stringify(module)};try{await acquireWorkspaceLease(${JSON.stringify(root)});process.exit(1)}catch(e){console.log(e.code)}`]);
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /workspace_busy/);
  } finally { lease.release(); }
  const crashed = await runChild([process.execPath, "--input-type=module", "-e", `import {acquireWorkspaceLease} from ${JSON.stringify(module)};const lease=await acquireWorkspaceLease(${JSON.stringify(root)});console.log(lease.owner);process.exit(0)`]);
  assert.equal((await recoverWorkspaceLease(root, crashed.stdout.trim())).recovered, true);
});

test("GitLab smoke closes the MR through the address when the body of the PUT is dropped, and says why when it cannot", async () => {
  const root = await temporary();
  const base = smokeClient();
  const calls = [];
  const dropsBody = { ...base, request: async (method, path, body) => {
    calls.push(`${method} ${path.replace(/^.*merge_requests\//, "")}${body ? " body" : ""}`);
    if (method === "PUT" && body) throw Object.assign(new Error("GitLab API failed (405): Method Not Allowed"), { status: 405 });
    return base.request(method, path, body);
  } };
  const report = await runGitLabSmoke({ client: dropsBody, project: 1, receiptPath: join(root, "query.jsonl"), confirmWrites: true });
  assert.equal(report.cleaned, true);
  assert.deepEqual(calls.filter((call) => call.startsWith("PUT")), ["PUT 2 body", "PUT 2?state_event=close"]);

  const refuses = { ...base, request: async (method, path, body) => {
    if (method === "PUT" || (method === "DELETE" && /merge_requests/.test(path))) throw new Error("GitLab API failed (403): 403 Forbidden");
    return base.request(method, path, body);
  } };
  await assert.rejects(
    runGitLabSmoke({ client: refuses, project: 1, receiptPath: join(root, "refused.jsonl"), confirmWrites: true }),
    /cleanup failed: mr-close-failed \(GitLab API failed \(403\): 403 Forbidden; its state: unknown; removing it failed too/,
  );
});

test("GitLab smoke counts a merge request as closed when GitLab answered 500 but the state says closed", async () => {
  const root = await temporary();
  const base = smokeClient();
  const crashesAfterClosing = { ...base, request: async (method, path, body) => {
    if (method === "PUT") throw new Error("GitLab API failed (500): 500 Internal Server Error [request id X1]");
    if (method === "GET") return { state: "closed" };
    if (method === "DELETE" && /merge_requests/.test(path)) throw new Error("GitLab API failed (403): 403 Forbidden");
    return base.request(method, path, body);
  } };
  const path = join(root, "after-error.jsonl");
  const report = await runGitLabSmoke({ client: crashesAfterClosing, project: 1, receiptPath: path, confirmWrites: true });
  assert.equal(report.cleaned, true);
  const last = JSON.parse((await readFile(path, "utf8")).trim().split("\n").at(-1));
  assert.ok(last.operations.includes("mr-closed-after-error"));
  assert.deepEqual(last.cleanupErrors, []);

  const stillOpen = { ...crashesAfterClosing, request: async (method, path2, body) => (method === "GET" ? { state: "opened" } : crashesAfterClosing.request(method, path2, body)) };
  const deletable = await runGitLabSmoke({ client: { ...stillOpen, request: async (method, path2, body) => (method === "DELETE" && /merge_requests/.test(path2) ? undefined : stillOpen.request(method, path2, body)) }, project: 1, receiptPath: join(root, "deleted.jsonl"), confirmWrites: true });
  assert.equal(deletable.cleaned, true);
  const lastDeleted = JSON.parse((await readFile(join(root, "deleted.jsonl"), "utf8")).trim().split("\n").at(-1));
  assert.ok(lastDeleted.operations.includes("mr-deleted-after-close-error"));

  await assert.rejects(
    runGitLabSmoke({ client: stillOpen, project: 1, receiptPath: join(root, "still-open.jsonl"), confirmWrites: true }),
    /cleanup failed: mr-close-failed \(GitLab API failed \(500\).*request id X1.*its state: opened; removing it failed too/,
  );
});
