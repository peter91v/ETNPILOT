import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundHistory, normalizeHistory } from "../src/core/history.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { evalApprovalHandler, prepareEvalWorkspace } from "../src/runtime/evals.js";
import { historyFrom, listSessions, readSession, runChatTurn } from "../src/runtime/chat-session.js";

// D0: a conversation is a sequence of runs that remember each other. Each turn
// is a real run — policy, approvals, sealed receipt — and the session only says
// which runs belong together.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-chat-"));
  await prepareEvalWorkspace({ task: "chat", files: { "README.md": "# fixture\n" }, scripted: [] }, root);
  return root;
}

// Records what each turn was told about the past.
function memoryProvider(seen) {
  return {
    scripted: async () => ({
      name: "scripted",
      capabilities: ["chat"],
      async invoke(context) {
        seen.push({ input: context.input, history: context.history });
        if (context.input.includes("explode")) throw new Error("the provider broke");
        return { text: `heard '${context.input}', remembering ${context.history.length} messages`, model: "m" };
      },
    }),
  };
}

const turn = (root, seen, sessionId, text) => runChatTurn({
  root,
  sessionId,
  text,
  agent: "orchestrator",
  providerFactories: memoryProvider(seen),
  approvalHandler: evalApprovalHandler(),
});

test("the second turn knows the first, and both receipts name their place in the session", async () => {
  const root = await project();
  const seen = [];
  const first = await turn(root, seen, undefined, "my name is Ada");
  const second = await turn(root, seen, first.sessionId, "what is my name?");

  assert.deepEqual(seen[0].history, []);
  assert.deepEqual(seen[1].history, [
    { role: "user", content: "my name is Ada" },
    { role: "assistant", content: first.reply },
  ]);
  assert.equal(second.turn, 2);
  assert.match(second.reply, /remembering 2 messages/);

  // The receipts carry the session, so a conversation can be read back out of
  // the evidence rather than out of a file that could say anything.
  const runs = join(root, ".etnpilot", "state", "runs");
  for (const [n, outcome] of [[1, first], [2, second]]) {
    const entries = (await readFile(join(runs, `${outcome.record.runId}.jsonl`), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.session?.id === first.sessionId && entry.session?.turn === n),
      `turn ${n} receipt names its session`);
  }
  const listed = await listSessions(root);
  assert.equal(listed[0].id, first.sessionId);
  assert.equal(listed[0].turns, 2);
});

test("a session resumes after a restart: it lives on disk, not in memory", async () => {
  const root = await project();
  const seen = [];
  const first = await turn(root, seen, undefined, "remember 42");
  const state = await openProjectState({ root });
  const reread = await state.chat.read(first.sessionId);
  assert.equal(reread.turns.length, 1);
  await turn(root, seen, first.sessionId, "and now?");
  assert.equal(seen.at(-1).history.length, 2);
  state.inbox.close?.();
  state.queue.close?.();
});

test("a turn that failed is in the log and out of the memory", async () => {
  const root = await project();
  const seen = [];
  const first = await turn(root, seen, undefined, "hello");
  await assert.rejects(turn(root, seen, first.sessionId, "please explode"), /provider broke/);
  await turn(root, seen, first.sessionId, "still there?");

  const { turns } = await readSession(root, first.sessionId);
  assert.deepEqual(turns.map((entry) => entry.status), ["succeeded", "failed", "succeeded"]);
  assert.match(turns[1].error, /provider broke/);
  // The failed exchange produced no answer, so the third turn is told about the
  // first only.
  assert.deepEqual(seen.at(-1).history.map((message) => message.content).slice(0, 1), ["hello"]);
  assert.equal(seen.at(-1).history.length, 2);
  assert.equal(historyFrom(turns).length, 4);
});

test("verifying a conversation checks every turn's receipt, and that it is this turn's", async () => {
  const root = await project();
  const seen = [];
  const first = await turn(root, seen, undefined, "one");
  await turn(root, seen, first.sessionId, "two");
  const state = await openProjectState({ root });
  try {
    const good = await state.chat.verify(first.sessionId);
    assert.equal(good.valid, true, JSON.stringify(good));
    assert.equal(good.turns.length, 2);

    // Point turn 2 at turn 1's run: a valid receipt, but not this turn's.
    const file = join(root, ".etnpilot", "state", "sessions", `${first.sessionId}.jsonl`);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    lines[1].runId = lines[0].runId;
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const bad = await state.chat.verify(first.sessionId);
    assert.equal(bad.valid, false);
    assert.match(bad.turns[1].note, /does not name this turn/);
  } finally {
    state.inbox.close?.();
    state.queue.close?.();
  }
});

test("a long conversation loses its oldest exchanges, and says so", () => {
  const exchange = (n) => [
    { role: "user", content: `question ${n} ${"x".repeat(400)}` },
    { role: "assistant", content: `answer ${n} ${"y".repeat(400)}` },
  ];
  const history = [1, 2, 3, 4, 5].flatMap(exchange);
  const bounded = boundHistory(history, 500);
  assert.ok(bounded.omitted >= 2);
  assert.equal(bounded.history[0].role, "user");
  assert.match(bounded.history[0].content, /earlier exchanges? of this conversation were? left out/);
  assert.match(bounded.history.at(-1).content, /answer 5/);
  // Never the whole of it, and never a partial exchange.
  assert.ok(bounded.history.length >= 2 && bounded.history.length % 2 === 0);
  assert.deepEqual(boundHistory(exchange(1), 100000), { history: exchange(1), omitted: 0 });
});

test("history that is not a conversation is refused, and a session id cannot leave its directory", async () => {
  assert.throws(() => normalizeHistory([{ role: "system", content: "x" }]), /history\[0\]/);
  assert.throws(() => normalizeHistory("hello"), /list/);
  const root = await project();
  await assert.rejects(readSession(root, "../../etc/passwd"), /not a session id/);
  await assert.rejects(runChatTurn({ root, text: "  ", agent: "orchestrator" }), /some text/);
});

test("the chat providers put earlier turns before the new message", async () => {
  const { createAnthropicProvider } = await import("../src/providers/anthropic.js");
  const { createOpenAICompatibleProvider } = await import("../src/providers/openai-compatible.js");
  const history = [{ role: "user", content: "my name is Ada" }, { role: "assistant", content: "hello Ada" }];
  const context = { runId: "r", agent: { name: "a", prompt: "P" }, input: "who am I?", history, instructions: [], skills: [], approve: async () => ({ kind: "approve-once" }) };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  let anthropicBody;
  await createAnthropicProvider({
    apiKey: "k",
    fetchImpl: async (url, init) => { anthropicBody = JSON.parse(init.body); return json({ content: [{ type: "text", text: "x" }], usage: {} }); },
  }).invoke(context);
  assert.deepEqual(anthropicBody.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(JSON.stringify(anthropicBody.messages[0]), /my name is Ada/);
  assert.match(JSON.stringify(anthropicBody.messages[2]), /who am I\?/);

  let openaiBody;
  await createOpenAICompatibleProvider({
    name: "o", apiKey: "k", baseUrl: "https://example.test/v1", model: "m",
    fetchImpl: async (url, init) => { openaiBody = JSON.parse(init.body); return json({ choices: [{ message: { content: "x" } }], usage: {} }); },
  }).invoke(context);
  assert.deepEqual(openaiBody.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
});

test("what the agent did is in the record, including what policy refused, whatever the reply says", async () => {
  const { callsOf } = await import("../src/runtime/chat-session.js");
  const outcome = {
    summary: {
      steps: {
        agent: {
          result: {
            result: {
              text: "I cannot change files here.",
              toolCalls: [
                { tool: "read_file", label: "read_file README.md", ok: true },
                { tool: "write_file", label: "write_file .etnpilot/etnpilot.yaml", ok: false, error: "Operation is denied by policy rule 'protect-etnpilot-governance'." },
              ],
            },
          },
        },
      },
    },
  };
  assert.deepEqual(callsOf(outcome), [
    { label: "read_file README.md", ok: true },
    { label: "write_file .etnpilot/etnpilot.yaml", ok: false, error: "Operation is denied by policy rule 'protect-etnpilot-governance'." },
  ]);
  assert.deepEqual(callsOf(undefined), []);

  const { describeCall } = await import("../src/providers/workspace-tools.js");
  assert.equal(describeCall("run_command", { command: ["npm", "test"] }), "run_command npm test");
  assert.equal(describeCall("search_files", "{\"pattern\":\"a\\u001b[31mb\"}"), "search_files a [31mb");
  assert.equal(describeCall("list_files", "not json"), "list_files");
});

test("the reasoning-effort conflict is explained whichever way the effort got there", async () => {
  const { createOpenAICompatibleProvider } = await import("../src/providers/openai-compatible.js");
  const refusal = () => new Response(JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } }), { status: 400, headers: { "content-type": "application/json" } });
  const run = (agent) => createOpenAICompatibleProvider({
    name: "openai", apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-6-luna", tools: true, workingDirectory: tmpdir(), fetchImpl: async () => refusal(),
  }).invoke({ runId: "r", agent: { name: "a", prompt: "P", ...agent }, input: "hi", instructions: [], skills: [], approve: async () => ({ kind: "approve-once" }) });
  // An effort chosen for the agent (or with /effort in a conversation).
  await assert.rejects(run({ effort: "high" }), /sent reasoning_effort 'high'.*\/effort reset/s);
  // Nothing chosen: the server's own default is the cause.
  await assert.rejects(run({}), /sends no reasoning_effort, so that is the server's own default/);
});
