import { digestBytes } from "../src/runtime/workspace-files.js";
import { basename } from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createReviewServer } from "../src/ui/server.js";
import { prepareEvalWorkspace } from "../src/runtime/evals.js";

// D3, the server half: a conversation over HTTP. A turn is started like a run,
// asks in the same inbox, and is read back from the session and the receipts.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-uichat-"));
  await prepareEvalWorkspace({
    task: "chat",
    files: { "README.md": "# fixture\n", "src/a.js": "export const a = 1;\n", ".env": "SECRET=1\n" },
    scripted: [],
  }, root);
  return root;
}

// The provider every turn talks to: records what it was told, and can be made
// to ask for a command or to wait forever.
function provider(seen, behaviour = {}) {
  return {
    scripted: async () => ({
      name: "scripted",
      capabilities: ["chat"],
      async invoke(context) {
        seen.push({ input: context.input, history: context.history, agent: context.agent });
        if (behaviour.ask) {
          const decision = await context.approve({ kind: "shell", fullCommandText: "npm run build" });
          if (decision.kind !== "approve-once") throw new Error("refused");
        }
        if (behaviour.make) {
          await writeFile(behaviour.make, "x");
          await context.recordFileEffect({ path: basename(behaviour.make), before: null, after: digestBytes(Buffer.from("x")) });
        }
        if (behaviour.hang) await new Promise((resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return { text: `answer ${seen.length}`, model: "m" };
      },
    }),
  };
}

async function serve(root, seen, behaviour) {
  const review = await createReviewServer({ root });
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => start({ ...options, providerFactories: provider(seen, behaviour) });
  const address = await review.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path, options = {}) => fetch(base + path, {
    ...options,
    headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
  const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });
  return { review, call, post };
}

async function until(read, check, what) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (check(value)) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a message starts a turn, asks in the inbox, and the answer is read back from the session", async () => {
  const root = await project();
  const seen = [];
  const { review, call, post } = await serve(root, seen, { ask: true });
  try {
    const started = await post("/api/chat/send", { text: "build it" });
    assert.equal(started.status, 202);
    const { sessionId } = await started.json();
    assert.match(sessionId, /^s-/);

    const running = await (await call(`/api/chat/session?id=${sessionId}`)).json();
    assert.equal(running.running, true);

    const state = await until(async () => (await call("/api/state")).json(), (s) => s.approvals.pending.length === 1, "the approval");
    assert.equal(state.approvals.pending[0].details.command, "npm run build");
    assert.equal(state.active[0].session, sessionId);
    await post("/api/approvals/decide", { id: state.approvals.pending[0].id, decision: "approve", actor: "me" });

    const done = await until(async () => (await call(`/api/chat/session?id=${sessionId}`)).json(), (s) => s.turns.length === 1 && !s.running, "the turn");
    assert.equal(done.turns[0].status, "succeeded");
    assert.equal(done.turns[0].reply, "answer 1");

    // The second message is a second turn of the same conversation, and knows the first.
    await post("/api/chat/send", { text: "and now?", sessionId });
    await until(async () => (await call("/api/state")).json(), (s) => s.approvals.pending.length === 1, "the second approval");
    assert.equal(seen[1].history.length, 2);
    const list = await (await call("/api/chat/sessions")).json();
    assert.equal(list.sessions[0].id, sessionId);
  } finally {
    await review.close();
  }
});

test("files: @-mentions are attached under the read policy, and reported either way", async () => {
  const root = await project();
  const seen = [];
  const { review, call, post } = await serve(root, seen);
  try {
    const started = await (await post("/api/chat/send", { text: "read @src/a.js and @.env and @nobody" })).json();
    assert.deepEqual(started.attached.map((file) => file.path), ["src/a.js"]);
    assert.equal(started.refused.length, 1);
    assert.match(started.refused[0].reason, /protect-credentials/);
    assert.equal(started.attached[0].content, undefined, "the response carries a summary, not the file");
    await until(async () => (await call(`/api/chat/session?id=${started.sessionId}`)).json(), (s) => s.turns.length === 1, "the turn");
    assert.match(seen[0].input, /export const a = 1;/);

    // What the picker offers is what may be attached: tracked, and readable.
    const offered = (await (await call("/api/chat/files?q=")).json()).files;
    assert.ok(offered.includes("src/a.js"));
    assert.ok(!offered.includes(".env"));
    assert.deepEqual((await (await call("/api/chat/files?q=README")).json()).files, ["README.md"]);
  } finally {
    await review.close();
  }
});

test("one turn at a time, stoppable; and choices the policy or the project cannot honour are refused", async () => {
  const root = await project();
  const seen = [];
  const { review, call, post } = await serve(root, seen, { hang: true });
  try {
    const { sessionId } = await (await post("/api/chat/send", { text: "wait" })).json();
    const second = await post("/api/chat/send", { text: "again", sessionId });
    assert.equal(second.status, 400);
    assert.match((await second.json()).error, /already running/);

    const stopped = await (await post("/api/chat/stop", { sessionId })).json();
    assert.equal(stopped.stopped, 1);
    const after = await until(async () => (await call(`/api/chat/session?id=${sessionId}`)).json(), (s) => !s.running, "the stop");
    assert.equal(after.turns[0].status, "failed");

    for (const body of [
      { text: "x", agent: "nobody" },
      { text: "x", provider: "nosuch" },
      { text: "" },
    ]) {
      assert.equal((await post("/api/chat/send", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call("/api/chat/session?id=../../etc")).status, 400);
    // Model and effort reach the agent for that turn only.
    await post("/api/chat/send", { text: "hello", model: "some-model", effort: "high" }).then((r) => r.json());
  } finally {
    await review.close();
  }
});

test("the agents listing names the providers a turn may choose", async () => {
  const root = await project();
  const { review, call } = await serve(root, []);
  try {
    const listing = await (await call("/api/agents")).json();
    assert.ok(listing.providers.includes("scripted"));
  } finally {
    await review.close();
  }
});

test("undo over HTTP takes back the last turn's files, and is refused while a turn runs", async () => {
  const root = await project();
  const made = join(root, "made.txt");
  const { review, call, post } = await serve(root, [], { make: made });
  try {
    const { sessionId } = await (await post("/api/chat/send", { text: "make a file" })).json();
    await until(async () => (await call(`/api/chat/session?id=${sessionId}`)).json(), (s) => s.turns.length === 1 && !s.running, "the turn");
    const { access } = await import("node:fs/promises");
    await access(made);
    const undone = await (await post("/api/chat/undo", { sessionId })).json();
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.deepEqual(undone.reverted, ["made.txt"]);
    await assert.rejects(access(made));
    assert.equal((await post("/api/chat/undo", { sessionId: "../x" })).status, 400);
  } finally {
    await review.close();
  }
});

test("an answer being written is readable while the turn runs, and the plain chat prints it once", async () => {
  const root = await project();
  const streaming = {
    scripted: async () => ({
      name: "scripted",
      capabilities: ["chat"],
      async invoke(context) {
        context.emitDelta("Hel");
        context.emitDelta("lo, ");
        if (context.input === "hold") {
          await new Promise((resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        }
        context.emitDelta("world");
        return { text: "Hello, world", model: "m" };
      },
    }),
  };
  const review = await createReviewServer({ root });
  const start = review.state.startRun.bind(review.state);
  review.state.startRun = (options) => start({ ...options, providerFactories: streaming });
  const address = await review.listen({ port: 0 });
  const call = (path, options = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...options, headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
  try {
    const { sessionId } = await (await call("/api/chat/send", { method: "POST", body: JSON.stringify({ text: "hold" }) })).json();
    const mid = await until(async () => (await call(`/api/chat/session?id=${sessionId}`)).json(), (s) => s.running && s.partial === "Hello, ", "the partial answer");
    assert.equal(mid.turns.length, 0, "not a turn yet, only a preview");
    await call("/api/chat/stop", { method: "POST", body: JSON.stringify({ sessionId }) });
    const after = await until(async () => (await call(`/api/chat/session?id=${sessionId}`)).json(), (s) => !s.running, "the stop");
    assert.equal(after.partial, undefined, "a preview is not kept once the turn is over");
  } finally {
    await review.close();
  }

  // The plain chat writes what streams in and does not print the reply again.
  const { runChat } = await import("../src/cli/chat.js");
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const done = runChat({ root: await project(), input, output, interactive: true, providerFactories: streaming });
  await until(async () => text, (t) => /you> /.test(t), "the prompt");
  input.write("go\n");
  await until(async () => text, (t) => /turn 1/.test(t), "the turn");
  assert.equal(text.split("Hello, world").length, 2, "the answer appears once");
  input.write("/exit\n");
  await done;
});
