import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openProjectState } from "../src/runtime/project-state.js";
import { prepareEvalWorkspace } from "../src/runtime/evals.js";
import { displayWidth, stripAnsi } from "../src/tui/ansi.js";
import { createTuiApp } from "../src/tui/app.js";

// D4: the same conversation in the terminal interface. A view over the same
// state as the page and the plain chat, with the keys of this interface.

function fakeOutput(columns = 100, rows = 30) {
  return { columns, rows, isTTY: false, write() {}, on() {}, off() {} };
}

const screen = (app) => stripAnsi(app.frame().join("\n"));

async function type(app, text) {
  for (const key of [...text]) await app.handle(key);
}

async function waitFor(condition, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

async function open({ behaviour = {}, columns, rows } = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tuichat-"));
  await prepareEvalWorkspace({
    task: "chat",
    files: { "README.md": "# fixture\n", "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 2;\n", ".env": "SECRET=1\n" },
    scripted: [],
  }, root);
  const state = await openProjectState({ root });
  const seen = [];
  const start = state.startRun.bind(state);
  state.startRun = (options) => start({
    ...options,
    providerFactories: {
      scripted: async () => ({
        name: "scripted",
        capabilities: ["chat"],
        async invoke(context) {
          seen.push({ input: context.input, history: context.history, agent: context.agent });
          if (behaviour.write) {
            const decision = await context.approve({
              kind: "write", fileName: "notes.txt", toolName: "write_file",
              toolArguments: { path: "notes.txt", bytes: 6 },
              diff: "--- /dev/null\n+++ notes.txt\n@@ -0,0 +1,2 @@\n+ready\n+set",
            });
            return { text: decision.kind === "approve-once" ? "I wrote notes.txt." : "Understood, I did not write it.", model: "m" };
          }
          if (behaviour.hang) await new Promise((resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          return { text: `heard: ${context.input.split("\n")[0]}`, model: "m" };
        },
      }),
    },
  });
  const app = createTuiApp({ state, output: fakeOutput(columns, rows), pollIntervalMs: 50 });
  await app.refresh();
  return { app, state, seen, close: () => state.close() };
}

test("'t' goes to the conversation with the cursor in the message; a message is sent, answered and remembered", async () => {
  const { app, seen, close } = await open();
  try {
    await app.handle("t");
    assert.equal(app.view, "chat");
    assert.ok(app.compose, "typing starts at once");
    assert.match(screen(app), /you> /);
    // 'q' and 'n' are letters here, not commands.
    await type(app, "quit now");
    assert.equal(app.compose.buffer, "quit now");
    await app.handle("\r");
    assert.equal(app.compose, undefined);
    assert.match(screen(app), /quit now/);
    assert.match(screen(app), /working…/);
    await waitFor(async () => { await app.refresh(); return /heard: quit now/.test(screen(app)); }, "the answer");
    assert.match(screen(app), /turn 1 · run /);

    await app.handle("\r");
    await type(app, "and again");
    await app.handle("\r");
    await waitFor(async () => { await app.refresh(); return /heard: and again/.test(screen(app)); }, "the second answer");
    assert.equal(seen[1].history.length, 2);
  } finally {
    close();
  }
});

test("the agent's question is drawn under the conversation with its diff, and a / r answer it", async () => {
  const { app, close } = await open({ behaviour: { write: true } });
  try {
    await app.handle("t");
    await type(app, "write the notes");
    await app.handle("\r");
    await waitFor(async () => { await app.refresh(); return /is waiting for you/.test(screen(app)); }, "the decision");
    const shown = screen(app);
    assert.match(shown, /WRITE/);
    assert.match(shown, /notes\.txt/);
    assert.match(shown, /\+ready/);
    assert.match(shown, /a approve once/);
    await app.handle("a");
    await waitFor(async () => { await app.refresh(); return /I wrote notes\.txt\./.test(screen(app)); }, "the answer after the yes");
    assert.doesNotMatch(screen(app), /is waiting for you/);
  } finally {
    close();
  }

  const refused = await open({ behaviour: { write: true } });
  try {
    await refused.app.handle("t");
    await type(refused.app, "write the notes");
    await refused.app.handle("\r");
    await waitFor(async () => { await refused.app.refresh(); return /is waiting for you/.test(screen(refused.app)); }, "the decision");
    await refused.app.handle("r");
    await waitFor(async () => { await refused.app.refresh(); return /did not write it/.test(screen(refused.app)); }, "the answer after the no");
  } finally {
    refused.close();
  }
});

test("commands change the next turn: agent, model, effort; a provider that is not there is refused", async () => {
  const { app, seen, close } = await open();
  try {
    await app.handle("t");
    for (const line of ["/agent nobody", "/model nosuch:gpt-x"]) {
      await type(app, line);
      await app.handle("\r");
    }
    assert.match(screen(app), /Refused|No provider 'nosuch'/);
    for (const line of ["/model claude-x", "/effort high"]) {
      await type(app, line);
      await app.handle("\r");
    }
    assert.match(screen(app), /model claude-x/);
    assert.match(screen(app), /effort high/);
    await type(app, "hello");
    await app.handle("\r");
    await waitFor(() => seen.length === 1, "the turn");
    assert.equal(seen[0].agent.model, "claude-x");
    assert.equal(seen[0].agent.effort, "high");
  } finally {
    close();
  }
});

test("@ offers the files that may be attached, Tab completes, and the file goes with the message", async () => {
  const { app, seen, close } = await open();
  try {
    await app.handle("t");
    await type(app, "what is in @src/");
    await waitFor(() => (app.compose?.suggestions ?? []).length === 2, "the suggestions");
    assert.match(screen(app), /\[src\/a\.js\]  src\/b\.js/);
    await app.handle("\t");
    assert.equal(app.compose.buffer, "what is in @src/a.js ");
    await type(app, "and @.env");
    await waitFor(async () => (await app.compose) !== undefined, "the line");
    await app.handle("\r");
    await waitFor(() => seen.length === 1, "the turn");
    assert.match(seen[0].input, /export const a = 1;/);
    assert.doesNotMatch(seen[0].input, /SECRET/);
    await waitFor(async () => { await app.refresh(); return /attached src\/a\.js/.test(screen(app)); }, "the attachment shown");
  } finally {
    close();
  }
});

test("s stops a running turn, and Esc leaves the message line without sending", async () => {
  const { app, close } = await open({ behaviour: { hang: true } });
  try {
    await app.handle("t");
    await type(app, "wait");
    await app.handle("\u001B");
    assert.equal(app.compose, undefined);
    assert.equal(app.chat.pending, undefined, "nothing was sent");

    await app.handle("i");
    await type(app, "wait");
    await app.handle("\r");
    await waitFor(async () => { await app.refresh(); return app.chat.running; }, "the turn to run");
    await app.handle("s");
    await waitFor(async () => { await app.refresh(); return !app.chat.running && app.chat.turns.length === 1; }, "the stop");
    assert.equal(app.chat.turns[0].status, "failed");
  } finally {
    close();
  }
});

test("it fits a phone and a wide terminal, and never draws past the edge", async () => {
  for (const [columns, rows] of [[40, 20], [60, 24], [100, 30]]) {
    const { app, close } = await open({ behaviour: { write: true }, columns, rows });
    try {
      await app.handle("t");
      await type(app, "please write the notes with a rather long message so that it has to wrap");
      await app.handle("\r");
      await waitFor(async () => { await app.refresh(); return /waiting for you/.test(screen(app)); }, "the decision");
      const frame = app.frame();
      assert.equal(frame.length, rows, `${columns}x${rows}: the frame is the screen`);
      for (const line of frame) assert.ok(displayWidth(line) <= columns, `${columns}x${rows}: "${stripAnsi(line)}" is too wide`);
      assert.match(stripAnsi(frame.join("\n")), /a approve|approve once/);
      await app.handle("r");
    } finally {
      close();
    }
  }
});
