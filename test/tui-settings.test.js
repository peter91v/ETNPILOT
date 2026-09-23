import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripAnsi } from "../src/tui/ansi.js";
import { renderApp, settingEntries, settingLiteral } from "../src/tui/render.js";
import { createTuiApp } from "../src/tui/app.js";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { openProjectState } from "../src/runtime/project-state.js";

async function settingsApp() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-settings-"));
  await initializeProject(root);
  const env = { ...process.env, ETNPILOT_CONFIG_HOME: join(root, "config-home") };
  const state = await openProjectState({ root, env });
  const output = {
    columns: 100, rows: 26, isTTY: false,
    written: [], write(text) { this.written.push(text); }, on() {}, off() {},
  };
  const app = createTuiApp({ state, output, input: new EventEmitter(), actor: "peter" });
  await app.refresh();
  await app.handle("4");
  return { root, env, state, app, file: join(root, ".etnpilot", "etnpilot.yaml") };
}

async function type(app, text) {
  for (const key of text) await app.handle(key);
}

// Moves the cursor onto one setting by filtering down to it alone.
async function select(app, path) {
  await app.handle("/");
  await app.handle("\u0015");
  await type(app, path);
  await app.handle("\r");
  assert.deepEqual(settingEntries(app.snapshot, { filter: app.filter }).map((entry) => entry.path), [path]);
}

function screen(app) {
  return stripAnsi(app.frame().join("\n"));
}

test("settings are a view of their own, showing where each value comes from", async () => {
  const { app, state } = await settingsApp();
  try {
    assert.equal(app.view, "settings");
    const text = screen(app);
    assert.match(text, /122 settings · none changed · writing to local/);
    assert.match(text, /SETTING\s+VALUE\s+FROM\s+CHANGE/);
    // The mode is on screen, so nobody has to guess what they may change.
    assert.match(text, /committed\s+open/);

    await select(app, "approval.allow");
    assert.match(screen(app), /approval\.allow\s+\["read"\]\s+committed\s+stricter-only/);
  } finally {
    state.close();
  }
});

test("an open setting is edited in place and written to the local file", async () => {
  const { app, state, root, env, file } = await settingsApp();
  try {
    await select(app, "queue.workers");
    await app.handle("\r");
    assert.equal(app.editor.entry.path, "queue.workers");
    // The editor starts from the value as it stands, not from an empty line.
    assert.equal(app.editor.buffer, "1");
    assert.match(screen(app), /New value as YAML, written to this project, locally/);

    await app.handle("\u0015");
    await type(app, "4");
    await app.handle("\r");

    assert.equal(app.editor, undefined);
    assert.match(app.message, /queue\.workers is now 4 — local, and never committed/);
    assert.equal((await loadConfig(file, env)).queue.workers, 4);
    assert.match(await readFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "utf8"), /workers: 4/);
    assert.match(screen(app), /1 changed locally/);
  } finally {
    state.close();
  }
});

test("a locked setting cannot be opened at all", async () => {
  const { app, state, root } = await settingsApp();
  try {
    await select(app, "receipts.signing.enabled");
    await app.handle("\r");
    assert.equal(app.editor, undefined);
    assert.match(app.message, /locked by the committed default/);
    await assert.rejects(readFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    state.close();
  }
});

test("a widening change is refused in the editor, where it was made", async () => {
  const { app, state, env, file } = await settingsApp();
  try {
    await select(app, "approval.allow");
    await app.handle("\r");
    assert.match(screen(app), /may only be narrowed, never widened/);

    await app.handle("\u0015");
    await type(app, '["read","write"]');
    await app.handle("\r");

    // The prompt stays open with the reason, so the change can be corrected.
    assert.equal(app.editor.entry.path, "approval.allow");
    assert.match(app.editor.error, /entries may only be removed; 'write' would be added/);
    assert.match(screen(app), /entries may only be removed/);
    assert.deepEqual((await loadConfig(file, env)).approval.allow, ["read"]);

    // Narrowing the same setting is accepted.
    await app.handle("\u0015");
    await type(app, "[]");
    await app.handle("\r");
    assert.equal(app.editor, undefined);
    assert.deepEqual((await loadConfig(file, env)).approval.allow, []);
  } finally {
    state.close();
  }
});

test("text that is not YAML is reported rather than written", async () => {
  const { app, state, env, file } = await settingsApp();
  try {
    await select(app, "queue.workers");
    await app.handle("\r");
    await app.handle("\u0015");
    await type(app, "[unclosed");
    await app.handle("\r");
    assert.match(app.editor.error, /not valid YAML/);
    assert.equal((await loadConfig(file, env)).queue.workers, 1);
  } finally {
    state.close();
  }
});

test("'d' puts a setting back to the committed default", async () => {
  const { app, state, env, file } = await settingsApp();
  try {
    await select(app, "queue.workers");
    await app.handle("\r");
    await app.handle("\u0015");
    await type(app, "8");
    await app.handle("\r");
    assert.equal((await loadConfig(file, env)).queue.workers, 8);

    await app.handle("d");
    assert.match(app.message, /back to the committed default: 1/);
    assert.equal((await loadConfig(file, env)).queue.workers, 1);

    await app.handle("d");
    assert.match(app.message, /already the committed default/);
  } finally {
    state.close();
  }
});

test("'s' switches which file a change is written to", async () => {
  const { app, state, env, root, file } = await settingsApp();
  try {
    assert.equal(app.scope, "local");
    await app.handle("s");
    assert.equal(app.scope, "global");
    assert.match(app.message, /~\/\.config, for every project/);

    await select(app, "observability.environment");
    await app.handle("\r");
    await app.handle("\u0015");
    await type(app, "staging");
    await app.handle("\r");

    assert.match(app.message, /global/);
    assert.equal((await loadConfig(file, env)).observability.environment, "staging");
    assert.match(await readFile(join(root, "config-home", "config.yaml"), "utf8"), /staging/);
  } finally {
    state.close();
  }
});

test("while a filter is typed, letters are text and not commands", async () => {
  const { app, state } = await settingsApp();
  try {
    await app.handle("/");
    assert.equal(app.filtering, true);
    // 'q' would otherwise quit and 'd' would reset a setting.
    assert.equal(await app.handle("q"), true);
    await type(app, "ueue");
    assert.equal(app.filter, "queue");
    assert.equal(app.view, "settings");
    // The caret is visible, so the mode is not a guess.
    assert.match(screen(app), /·\s+filter queue/);

    await app.handle("\u007F");
    assert.equal(app.filter, "queu");
    await app.handle("\r");
    assert.equal(app.filtering, false);
    assert.match(screen(app), /filter 'queu'/);

    await app.handle("/");
    await app.handle("\u001B");
    assert.equal(app.filter, "");
    assert.equal(app.filtering, false);
  } finally {
    state.close();
  }
});

test("a setting this session already opened says so instead of pretending", async () => {
  const { app, state } = await settingsApp();
  try {
    await select(app, "queue.database");
    await app.handle("\r");
    await app.handle("\u0015");
    await type(app, '".etnpilot/state/other.sqlite"');
    await app.handle("\r");
    assert.match(app.message, /this session already opened that file — restart to use it/);
  } finally {
    state.close();
  }
});

test("a refused local setting is reported in the view, not only by the next run", async () => {
  const { app, state, root } = await settingsApp();
  try {
    await writeFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "secrets:\n  values: {}\n", "utf8");
    await app.refresh();

    // The loader would refuse this file, so the view says so before a run does.
    const text = screen(app);
    assert.match(text, /1 local setting is refused; a run will not start until it is gone/);
    assert.match(text, /secrets\.values — the project default locks this setting/);
    // The list is still usable, so the setting can be found and put back.
    assert.match(text, /SETTING\s+VALUE\s+FROM\s+CHANGE/);

    // Approvals and runs still work.
    await app.handle("1");
    assert.equal(app.view, "approvals");
    assert.match(screen(app), /Nothing is waiting for a decision/);
  } finally {
    state.close();
  }
});

test("a settings frame still fits the terminal it was given", () => {
  const snapshot = {
    settings: {
      overrides: ["queue.workers"],
      entries: [
        { path: "queue.workers", value: 4, defaultValue: 1, source: "user-local", mode: "open" },
        { path: "approval.allow", value: [], defaultValue: ["read"], source: "user-local", mode: "stricter-only" },
        { path: "receipts.signing.enabled", value: false, defaultValue: false, source: "project", mode: "locked" },
      ],
    },
  };
  for (const width of [40, 64, 100]) {
    const frame = renderApp(snapshot, { view: "settings", width, height: 14, color: true });
    assert.equal(frame.length, 14);
    for (const line of frame) assert.ok(stripAnsi(line).length <= width, `${stripAnsi(line)} exceeds ${width}`);
  }

  const editor = renderApp(snapshot, {
    view: "settings",
    width: 80,
    height: 16,
    color: false,
    editor: { entry: snapshot.settings.entries[1], buffer: '["read"]', scope: "local" },
  }).join("\n");
  assert.match(editor, /approval\.allow\s+stricter-only/);
  assert.match(editor, /Committed default/);
  assert.match(editor, /In effect, from local/);
  assert.match(editor, /enter save/);

  assert.equal(settingLiteral([1, 2]), "[1,2]");
  assert.equal(settingLiteral(undefined), "");
});
