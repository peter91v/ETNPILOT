import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git/command.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { runProject } from "../src/runtime/project-runner.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { createTuiApp } from "../src/tui/app.js";
import { waitFor } from "./helpers/wait.js";

// A run whose second step failed, opened in the TUI: 'p' asks whether it could
// be continued, and only with that plan on screen does 'R' start it.

async function failedRun() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tui-resume-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake",
    "content:", "  provenance:", "    mode: off", "codegraph:", "  enabled: false", "observability:", "  enabled: false",
    "workflow:", "  steps:", "    - id: first", "      type: agent", "      agent: worker",
    "    - id: second", "      type: agent", "      agent: worker", "      needs: [first]", "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  let calls = 0;
  const failing = { fake: (name) => ({ name, invoke: async () => { calls += 1; if (calls === 1) return { text: "first done" }; throw new Error("the second step broke"); } }) };
  await runProject({ root, input: "do both", providerFactories: failing }).then(() => assert.fail("meant to fail"), () => {});
  return root;
}

const fakeOutput = () => ({ columns: 100, rows: 40, isTTY: false, write() {}, on() {}, off() {} });
const screen = (app) => stripAnsi(app.frame().join("\n"));

test("'p' shows the plan for a failed run, and 'R' starts the resumption", async () => {
  const root = await failedRun();
  const state = await openProjectState({ root });
  const asked = [];
  const original = state.resumeRun;
  state.resumeRun = (file, options) => original(file, { ...options, providerFactories: { fake: (name) => ({ name, invoke: async ({ input }) => { asked.push(input); return { text: "second done" }; } }) } });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("2");
    await app.handle("\r");
    assert.equal(app.detail, true);
    assert.match(screen(app), /press 'p' to see whether this run could be continued/);

    // 'R' does nothing until the plan is on screen.
    await app.handle("R");
    assert.equal(app.detail, true, "R without a plan started nothing");

    await app.handle("p");
    const text = screen(app);
    assert.match(text, /it stopped in 'second': the second step broke/);
    assert.match(text, /reuse\s+first/);
    assert.match(text, /run again\s+second/);
    assert.match(text, /could be resumed — press 'R' to start it/);

    await app.handle("R");
    assert.equal(app.detail, false);
    await waitFor(async () => { await app.refresh(); return app.active.length === 0 && asked.length === 1; }, "the resumed run to finish");
    assert.match(asked[0], /first done/);
    const runs = join(root, ".etnpilot", "state", "runs");
    const files = (await readdir(runs)).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, 2);
    const resumed = (await Promise.all(files.map(async (file) => JSON.parse((await readFile(join(runs, file), "utf8")).split("\n")[0])))).find((start) => start.resumedFrom);
    assert.deepEqual(resumed.resumedFrom.reusedSteps.map((entry) => entry.step), ["first"]);
  } finally {
    app.stop();
    state.close();
  }
});

test("a run that cannot be continued shows why, and 'R' stays a no-op", async () => {
  const root = await failedRun();
  const runs = join(root, ".etnpilot", "state", "runs");
  const [file] = await readdir(runs);
  const start = JSON.parse((await readFile(join(runs, file), "utf8")).split("\n")[0]);
  await appendFile(join(start.workspace.path, "first.txt"), "edited afterwards\n");
  const state = await openProjectState({ root });
  const app = createTuiApp({ state, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("2");
    await app.handle("\r");
    await app.handle("p");
    assert.match(screen(app), /cannot be resumed/);
    assert.match(screen(app), /workspace differs/i);
    await app.handle("R");
    assert.equal(app.detail, true);
    assert.equal(app.active.length, 0);
  } finally {
    app.stop();
    state.close();
  }
});
