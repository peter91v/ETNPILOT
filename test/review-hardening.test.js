import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { replayRun } from "../src/runtime/replay.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { resolveAttachments } from "../src/runtime/chat-attachments.js";
import { createMcpClient } from "../src/providers/mcp-client.js";
import { providerToolNames } from "../src/providers/tool-names.js";
import { searchLines } from "../src/providers/search-worker-host.js";
import { runChild } from "../src/runtime/child-process.js";
import { acquireWorkspaceLease, recoverWorkspaceLease } from "../src/runtime/workspace-lease.js";
import { runChatTurn, readSession, usageOf } from "../src/runtime/chat-session.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { readUsage } from "../src/runtime/project-state.js";
import { undoFileEffects } from "../src/runtime/file-effects.js";
import { digestBytes } from "../src/runtime/workspace-files.js";
import { createReviewServer } from "../src/ui/server.js";
import { PluginWorkerHost } from "../src/plugins/worker-host.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { invocationMeter } from "../src/providers/usage-meter.js";
import { Telemetry, summarizeTelemetryFile, telemetryProviderAttributes } from "../src/observability/telemetry.js";
import { knownPriceForModel, useLearnedRates } from "../src/observability/known-pricing.js";

const temporary = () => mkdtemp(join(tmpdir(), "etnpilot-hardening-"));
const allowed = { approve: async () => ({ kind: "approve-once" }) };
const digest = (text) => digestBytes(Buffer.from(text));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("session accounting includes completed and failed steps without telemetry", async () => {
  const engine = new WorkflowEngine({ failFast: false });
  const summary = await engine.run([{ id: "first" }, { id: "second" }], async (step) => {
    if (step.id === "first") return { result: { model: "m", usage: { inputTokens: 10, outputTokens: 2, requests: 1 } } };
    const error = new Error("interrupted");
    error.usage = { inputTokens: 5, outputTokens: 1, requests: 2, usageStatus: "partial" };
    throw error;
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(usageOf({ summary }), { inputTokens: 15, outputTokens: 3, requests: 3, model: "m", usageStatus: "partial" });
});

test("retrospective pricing uses configured currency and invalidates cached tariff", async () => {
  const root = await temporary(); const file = join(root, "telemetry.jsonl");
  const telemetry = new Telemetry({ file, root });
  const accounting = telemetry.recordProviderUsage({ model: "fixture-unpriced", usage: { inputTokens: 1_000_000 } });
  await telemetry.startSpan("fixture").end({ attributes: telemetryProviderAttributes(accounting) });
  const config = { observability: { enabled: true, file, pricing: { autoUpdate: false, currency: "EUR", models: { "fixture-unpriced": { inputPerMillion: 2, outputPerMillion: 0 } } } } };
  const summary = await summarizeTelemetryFile(file, { root, config });
  assert.equal(summary.currency, "EUR"); assert.equal(summary.estimatedCost, 2);
  assert.equal((await readUsage({ root, config })).estimatedCost, 2);
  config.observability.pricing.models["fixture-unpriced"].inputPerMillion = 3;
  assert.equal((await readUsage({ root, config })).estimatedCost, 3);
});

for (const mode of ["tampered", "unsigned", "incomplete"]) test(`replay ${mode} evidence never reaches an executor`, async () => {
  const root = await temporary(); const path = join(root, "receipt.jsonl");
  const store = new JsonlReceiptStore(path);
  await store.append({ terminal: mode !== "incomplete", runId: "r", status: "succeeded", summary: { steps: { check: { status: "succeeded", result: { command: ["node", "-e", "process.exit()"], exitCode: 0 } } } } });
  if (mode === "tampered") await writeFile(path, (await readFile(path, "utf8")).replace('"runId":"r"', '"runId":"evil"'));
  let executed = 0;
  const result = await replayRun(path, { root, requireSignatures: mode === "unsigned", execute: async () => { executed += 1; } });
  assert.equal(result.receiptValid, false); assert.equal(executed, 0);
});

test("valid replay filters environment and inspection executes nothing", async () => {
  const root = await temporary(); const path = join(root, "receipt.jsonl");
  await new JsonlReceiptStore(path).append({ terminal: true, runId: "r", summary: { steps: { check: { status: "succeeded", result: { command: ["node", "-e", ""], exitCode: 0 } } } } });
  let passed;
  await replayRun(path, { root, env: { PATH: "/bin", PRIVATE_TOKEN: "fixture-only" }, execute: async (_, options) => { passed = options.env; return { exitCode: 0 }; } });
  assert.equal(passed.PATH, "/bin"); assert.equal(passed.PRIVATE_TOKEN, undefined);
  await replayRun(path, { root, inspectOnly: true, execute: () => assert.fail("inspection executed a command") });
});

for (const tool of ["edit_file", "write_file"]) test(`${tool} authorizes reads before diff or substring discovery`, async () => {
  const root = await temporary(); await writeFile(join(root, "private.txt"), "secret-substring");
  const requests = [];
  const result = await createWorkspaceTools({ workingDirectory: root }).invoke(tool, { path: "private.txt", content: "new", old_string: "absent", new_string: "new" }, {
    approve: async (request) => { requests.push(request); return { kind: "reject", reason: "private" }; },
  });
  assert.equal(result.ok, false); assert.deepEqual(requests.map((request) => request.kind), ["read"]);
  assert.equal(requests[0].diff, undefined); assert.doesNotMatch(result.error, /substring|absent|appear/);
});

test("file changes during approval are preserved, and symlink swaps cannot write outside", async () => {
  const root = await temporary(); const outside = await temporary();
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "a.txt"), "before");
  await writeFile(join(outside, "a.txt"), "outside");
  const tools = createWorkspaceTools({ workingDirectory: root });
  const changed = await tools.invoke("write_file", { path: "src/a.txt", content: "agent" }, { approve: async (request) => {
    if (request.kind === "write") await writeFile(join(root, "src", "a.txt"), "human"); return { kind: "approve-once" };
  } });
  assert.equal(changed.ok, false); assert.match(changed.error, /changed/); assert.equal(await readFile(join(root, "src", "a.txt"), "utf8"), "human");
  const swapped = await tools.invoke("write_file", { path: "src/a.txt", content: "agent" }, { approve: async (request) => {
    if (request.kind === "write") { await rename(join(root, "src"), join(root, "original")); await symlink(outside, join(root, "src")); } return { kind: "approve-once" };
  } });
  assert.equal(swapped.ok, false); assert.equal(await readFile(join(outside, "a.txt"), "utf8"), "outside");
});

test("attachments hold human-required reads and charge directories to byte budgets", async () => {
  const root = await temporary(); await writeFile(join(root, "a.txt"), "private"); await mkdir(join(root, "dir"));
  for (let n = 0; n < 10; n += 1) await writeFile(join(root, "dir", `${n}.txt`), "");
  const withheld = await resolveAttachments("@a.txt", { root, authorize: async () => ({ kind: "human-required" }) });
  assert.equal(withheld.attachments.length, 0); assert.equal(withheld.refused.length, 1);
  const limited = await resolveAttachments("@dir @a.txt", { root, limits: { maxFileBytes: 12, maxTotalBytes: 12, maxDirectoryEntries: 100 } });
  assert.ok(limited.attachments.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 12); assert.equal(limited.attachments[0].truncated, true);
});

test("fetch cancels a large response and truncates on UTF-8 byte boundaries", async () => {
  const root = await temporary(); let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("€€€")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/plain" } });
  const result = await createWorkspaceTools({ workingDirectory: root, limits: { maxFetchBytes: 4 }, fetchImpl }).invoke("fetch_url", { url: "https://example.invalid" }, allowed);
  assert.equal(result.content, "€"); assert.equal(result.truncated, true); assert.equal(cancelled, true);
});

test("regex CPU limits leave the event loop responsive, and cancellation terminates its worker", async () => {
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 20);
  const result = await searchLines({ files: [{ path: "a", content: `${"a".repeat(40)}!` }], pattern: "(a+)+$", limit: 10 }, { timeoutMs: 150 });
  clearTimeout(timer); assert.equal(ticked, true); assert.equal(result.ok, false); assert.match(result.error, /limit/);
  const controller = new AbortController(); const pending = searchLines({ files: [{ path: "a", content: `${"a".repeat(40)}!` }], pattern: "(a+)+$", limit: 10 }, { signal: controller.signal });
  controller.abort(new Error("stop search")); await assert.rejects(pending, /stop search/);
  const literal = await searchLines({ files: [{ path: "a", content: "(a+)+$" }], pattern: "(a+)+$", literal: true, limit: 1 }); assert.equal(literal.matches.length, 1);
});

test("tool aliases are valid, reversible, and collision checked", () => {
  const names = providerToolNames([{ name: "codegraph.codegraph_explore" }, { name: "a.b" }, { name: "a_b" }]);
  for (const tool of names.definitions) assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(names.internal(names.definitions[0].name), "codegraph.codegraph_explore");
  assert.notEqual(names.definitions[1].name, names.definitions[2].name);
  assert.throws(() => providerToolNames([{ name: "a" }, { name: "a" }]), /Duplicate/);
});

for (const output of ["null\\n", "[]\\n", "{broken}\\n", "x".repeat(2048)]) test(`malformed MCP output ${output.slice(0, 10)} is contained`, async () => {
  const client = createMcpClient({ name: "hostile", command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(output.replaceAll("\\n", "\n"))});setInterval(()=>{},1000)`], limits: { maxMessageBytes: 1024 }, timeoutMs: 2000 });
  try { await assert.rejects(client.initialize(), /JSON|message byte limit|envelope/); }
  finally { await client.close(); }
});

test("command timeout kills descendants that would write after the leader exits", async () => {
  const root = await temporary(); const path = join(root, "descendant.txt");
  const child = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(path)},'escaped'),500);setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const result = await runChild([process.execPath, "-e", parent], { timeoutMs: 100 }); assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 550)); await assert.rejects(access(path), /ENOENT/);
});

test("workspace leases reject concurrent instances and do not recover a live owner", async () => {
  const root = await temporary(); const lease = await acquireWorkspaceLease(root, { sessionId: "s-first" });
  try { await assert.rejects(acquireWorkspaceLease(root), /workspace is leased/); await assert.rejects(recoverWorkspaceLease(root, lease.owner), /still running/); }
  finally { lease.release(); }
  const next = await acquireWorkspaceLease(root); next.release();
});

test("chat turn numbers are serialized before the first runner await", async () => {
  const root = await temporary(); let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = async () => { entered(); await gate; return { status: "succeeded", summary: { steps: { agent: { result: { text: "ok" } } } } }; };
  const first = runChatTurn({ root, sessionId: "s-concurrent", text: "one", runner }); await started;
  await assert.rejects(runChatTurn({ root, sessionId: "s-concurrent", text: "two", runner }), /workspace is leased/);
  release(); await first;
  await runChatTurn({ root, sessionId: "s-concurrent", text: "two", runner });
  assert.deepEqual((await readSession(root, "s-concurrent")).turns.map((turn) => turn.turn), [1, 2]);
});

test("undo touches only journaled changes and preserves unrelated and changed files", async () => {
  const root = await temporary(); await writeFile(join(root, "owned.txt"), "agent"); await writeFile(join(root, "foreign.txt"), "human");
  const effects = [{ path: "owned.txt", before: digest("before"), after: digest("agent"), beforeContent: "before" }];
  assert.deepEqual((await undoFileEffects(root, effects)).reverted, ["owned.txt"]);
  assert.equal(await readFile(join(root, "foreign.txt"), "utf8"), "human");
  const skipped = await undoFileEffects(root, effects); assert.equal(skipped.reverted.length, 0); assert.equal(skipped.skipped.length, 1);
});

for (const kind of ["openai", "anthropic"]) test(`${kind} retains partial usage, counts retries, and stops between requests at budgets`, async () => {
  const root = await temporary(); await writeFile(join(root, "a.txt"), "a"); let calls = 0;
  const first = kind === "openai" ? { model: "model", usage: { prompt_tokens: 20, completion_tokens: 3 }, choices: [{ message: { tool_calls: [{ id: "t", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }] } : { model: "model", usage: { input_tokens: 10, cache_read_input_tokens: 8, cache_creation_input_tokens: 2, output_tokens: 3 }, content: [{ type: "tool_use", id: "t", name: "read_file", input: { path: "a.txt" } }] };
  const factory = kind === "openai" ? createOpenAICompatibleProvider : createAnthropicProvider;
  const provider = factory({ apiKey: "fixture", baseUrl: "https://example.invalid", model: "model", tools: true, workingDirectory: root, retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 }, fetchImpl: async () => { calls += 1; return calls === 1 ? json(first) : json({ error: { message: "unavailable" } }, 503); } });
  const telemetry = new Telemetry(); const context = { ...allowed, runId: "r", agent: { name: "a", model: "model" }, input: "go", instructions: [], telemetry };
  const meter = invocationMeter(context, kind);
  let failure; try { await provider.invoke(meter.context); } catch (error) { failure = error; meter.finish(undefined, error); }
  assert.equal(failure.usage.inputTokens, 20); assert.equal(failure.usage.requests, 2); assert.equal(telemetry.summary("r").requests, 2);
  calls = 0; const bounded = new Telemetry({ budgets: { maxInputTokensPerWorkflow: 15 } }); const limited = invocationMeter({ ...context, telemetry: bounded }, kind);
  await assert.rejects(provider.invoke(limited.context), /budget exceeded/); assert.equal(calls, 1);
});

test("project price catalogs are scoped, dated, and disabled independently", () => {
  const now = Date.parse("2026-10-01"); const rates = { "gpt-5-4": { inputPerMillion: 7, outputPerMillion: 8 } };
  useLearnedRates(rates, { root: "/project-a", asOf: "2026-09-30", source: "catalog-a" });
  assert.equal(knownPriceForModel("gpt-5.4", { root: "/project-a", now }).inputPerMillion, 7);
  assert.equal(knownPriceForModel("gpt-5.4", { root: "/project-b", now }).inputPerMillion, 2.5);
  assert.equal(knownPriceForModel("gpt-5.4", { root: "/project-a", now, autoUpdate: false }).inputPerMillion, 2.5);
  assert.equal(knownPriceForModel("gpt-6-astra", { now }).status, "inferred-id");
  const pricing = new Telemetry({ root: "/project-a", now: () => now }).recordProviderUsage({ agentRunId: "r", model: "gpt-5.4", usage: { inputTokens: 1_000_000 } });
  assert.equal(pricing.estimatedCost, 7); assert.equal(pricing.pricing.source, "catalog-a");
});

test("missing RSS fails closed; explicit heap-only mode is separately declared", async () => {
  const root = await temporary(); await writeFile(join(root, "plugin.mjs"), 'export default {apiVersion:1,name:"fixture",version:"1.0.0",capabilities:[],setup(){}};');
  await assert.rejects(PluginWorkerHost.start({ specifier: "./plugin.mjs", projectRoot: root, resources: { measureMemory: async () => NaN } }), /RSS monitoring is unavailable/);
  const loaded = await PluginWorkerHost.start({ specifier: "./plugin.mjs", projectRoot: root, limits: { memoryMonitoring: "heap-only" }, resources: { measureMemory: async () => assert.fail("heap-only measured RSS") } });
  await loaded.host.close();
});

test("adapter discovery failure resolves UI listening with a fallback address", async () => {
  const root = await temporary(); const server = await createReviewServer({ root, token: "fixture", getNetworkInterfaces: () => { throw new Error("unavailable"); } });
  try { const listening = await server.listen({ host: "0.0.0.0", port: 0 }); assert.equal(listening.exposed, true); assert.match(listening.url, /127\.0\.0\.1/); }
  finally { await server.close(); }
});
