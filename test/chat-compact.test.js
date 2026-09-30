import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { evalApprovalHandler, prepareEvalWorkspace } from "../src/runtime/evals.js";
import { compactSession, compactionCheck, historyFrom, readSession, runChatTurn } from "../src/runtime/chat-session.js";
import { openProjectState } from "../src/runtime/project-state.js";

// D5: /compact. The older turns are carried as a summary the model wrote, as a
// run of its own; the turns stay on disk, and the session says it was compacted.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-compact-"));
  await prepareEvalWorkspace({ task: "chat", files: { "README.md": "# fixture\n" }, scripted: [] }, root);
  return root;
}

function recording(seen, { summary = "SUMMARY: the user is building a widget.", fail = false } = {}) {
  return {
    scripted: async () => ({
      name: "scripted",
      capabilities: ["chat"],
      async invoke(context) {
        seen.push({ input: context.input, history: context.history, agent: context.agent });
        if (context.input.startsWith("Summarise this conversation")) {
          if (fail) throw new Error("no summary today");
          return { text: summary, model: "m" };
        }
        return { text: `heard ${context.input}`, model: "m" };
      },
    }),
  };
}

const common = (seen, options) => ({ agent: "orchestrator", providerFactories: recording(seen, options), approvalHandler: evalApprovalHandler() });

async function conversation(root, seen, turns = 3) {
  let sessionId;
  for (let n = 1; n <= turns; n += 1) {
    ({ sessionId } = await runChatTurn({ root, sessionId, text: `message ${n}`, ...common(seen) }));
  }
  return sessionId;
}

test("the older turns become a summary the model wrote; the turns stay where they were", async () => {
  const root = await project();
  const seen = [];
  const sessionId = await conversation(root, seen, 3);
  const result = await compactSession({ root, sessionId, ...common(seen) });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.upToTurn, 3);

  // A run of its own, with the conversation to read and no tool to use.
  const asked = seen.at(-1);
  assert.match(asked.input, /^Summarise this conversation/);
  assert.equal(asked.history.length, 6);
  assert.deepEqual(asked.agent.tools, []);

  const session = await readSession(root, sessionId);
  assert.equal(session.turns.length, 3, "the turns are unchanged on disk");
  assert.equal(session.compactions.length, 1);
  assert.equal(session.compactions[0].summary, "SUMMARY: the user is building a widget.");

  // The next turn is told the summary instead of the three exchanges.
  await runChatTurn({ root, sessionId, text: "message 4", ...common(seen) });
  const history = seen.at(-1).history;
  assert.equal(history.length, 2);
  assert.match(history[0].content, /Summary of this conversation up to turn 3/);
  assert.match(history[0].content, /building a widget/);
  assert.doesNotMatch(JSON.stringify(history), /message 1/);

  // And a fifth turn: the summary, then only what came after it.
  await runChatTurn({ root, sessionId, text: "message 5", ...common(seen) });
  assert.equal(seen.at(-1).history.length, 4);
  assert.equal(historyFrom(session.turns, session.compactions).length, 2);
});

test("a compacted conversation still verifies, and a summary that points at the wrong run does not", async () => {
  const root = await project();
  const seen = [];
  const sessionId = await conversation(root, seen, 2);
  await compactSession({ root, sessionId, ...common(seen) });
  const state = await openProjectState({ root });
  try {
    const good = await state.chat.verify(sessionId);
    assert.equal(good.valid, true, JSON.stringify(good));
    assert.equal(good.turns.length, 3);
    assert.match(good.turns.at(-1).note, /names this summary/);

    const file = join(root, ".etnpilot", "state", "sessions", `${sessionId}.jsonl`);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const first = lines.find((line) => line.turn === 1 && !line.type);
    lines.find((line) => line.type === "compact").runId = first.runId;
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const bad = await state.chat.verify(sessionId);
    assert.equal(bad.valid, false);
    assert.match(bad.turns.at(-1).note, /does not name a summary/);
  } finally {
    state.close();
  }
});

test("nothing is written when there is nothing to summarise, or when the summary fails", async () => {
  const root = await project();
  const seen = [];
  assert.equal((await compactionCheck(root, undefined)).ok, false);
  const sessionId = await conversation(root, seen, 1);
  const tooEarly = await compactSession({ root, sessionId, ...common(seen) });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /fewer than two new turns/);
  assert.equal(seen.length, 1, "the model was not asked");

  await runChatTurn({ root, sessionId, text: "message 2", ...common(seen) });
  await assert.rejects(compactSession({ root, sessionId, ...common(seen, { fail: true }) }), /no summary today/);
  assert.equal((await readSession(root, sessionId)).compactions.length, 0, "a failed summary leaves the conversation as it was");

  const empty = await compactSession({ root, sessionId, ...common(seen, { summary: "   " }) });
  assert.equal(empty.ok, false);
  assert.equal((await readSession(root, sessionId)).compactions.length, 0);
});

test("an agent allowed no tool is sent no tool list, to either kind of provider", async () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const context = { runId: "r", agent: { name: "a", prompt: "P", tools: [] }, input: "hi", instructions: [], skills: [], approve: async () => ({ kind: "approve-once" }) };
  let anthropicBody;
  await createAnthropicProvider({
    apiKey: "k", tools: true, workingDirectory: tmpdir(),
    fetchImpl: async (url, init) => { anthropicBody = JSON.parse(init.body); return json({ content: [{ type: "text", text: "x" }], usage: {} }); },
  }).invoke(context);
  assert.equal("tools" in anthropicBody, false);
  let chatBody;
  await createOpenAICompatibleProvider({
    name: "o", apiKey: "k", baseUrl: "https://example.test/v1", model: "m", tools: true, workingDirectory: tmpdir(),
    fetchImpl: async (url, init) => { chatBody = JSON.parse(init.body); return json({ choices: [{ message: { content: "x" } }], usage: {} }); },
  }).invoke(context);
  assert.equal("tools" in chatBody, false);
  assert.equal("tool_choice" in chatBody, false);
});
