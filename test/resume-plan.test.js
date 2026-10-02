import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/commands.js";
import { git } from "../src/git/command.js";
import { planResume } from "../src/runtime/resume-plan.js";
import { acquireWorktreeLock } from "../src/runtime/worktree-lock.js";
import { runProject } from "../src/runtime/project-runner.js";

// A project whose workflow has two agent steps; the provider fails the second
// one on its first try. What a failed run leaves behind is what a plan reads.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-resume-"));
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
  return root;
}

// The first agent writes a file; the second one fails.
function failingSecond() {
  let calls = 0;
  return {
    fake: (name) => ({
      name,
      invoke: async ({ metadata }) => {
        calls += 1;
        if (calls === 1) {
          await writeFile(join(metadata.workspace, "first.txt"), "from the first step\n");
          return { text: "first done" };
        }
        throw new Error("the second step broke");
      },
    }),
  };
}

async function failedRun() {
  const root = await project();
  const error = await runProject({ root, input: "do both", providerFactories: failingSecond(), cleanupWorktree: false }).then(() => undefined, (failure) => failure);
  assert.ok(error, "the run was meant to fail");
  const runs = join(root, ".etnpilot", "state", "runs");
  const [file] = (await readdir(runs)).filter((name) => name.endsWith(".jsonl"));
  return { root, file, path: join(runs, file) };
}

test("a run that failed in its second step can be resumed: the first is reused, the second runs again", async () => {
  const { root, file } = await failedRun();
  const plan = await planResume({ root, receipt: file });
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.resumable, true);
  assert.deepEqual(plan.steps.map((step) => [step.id, step.action]), [["first", "reuse"], ["second", "rerun"]]);
  assert.equal(plan.steps[0].effect, "workspace");
  assert.equal(plan.status, "failed");
});

test("a changed workspace is a reason not to resume", async () => {
  const { root, file, path } = await failedRun();
  const start = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
  await appendFile(join(start.workspace.path, "first.txt"), "edited afterwards\n");
  const plan = await planResume({ root, receipt: file });
  assert.equal(plan.resumable, false);
  assert.equal(plan.refusals[0].code, "workspace-changed");
});

test("a changed configuration is a reason not to resume, unless the drift is allowed", async () => {
  const { root, file, path } = await failedRun();
  const start = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
  await appendFile(join(start.workspace.path, ".etnpilot", "etnpilot.yaml"), "queue:\n  workers: 3\n");
  // The edit is a workspace change too; put the workspace check aside by
  // looking only at the configuration's own refusal.
  const plan = await planResume({ root, receipt: file });
  assert.ok(plan.refusals.some((refusal) => refusal.code === "config-changed"));
  const allowed = await planResume({ root, receipt: file, allowDrift: true });
  assert.equal(allowed.refusals.some((refusal) => refusal.code === "config-changed"), false);
  assert.ok(allowed.drift);
});

test("a tampered receipt is refused with the reason verification gives", async () => {
  const { root, file, path } = await failedRun();
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"first"', '"firsT"'));
  const plan = await planResume({ root, receipt: file });
  assert.equal(plan.resumable, false);
  assert.equal(plan.refusals[0].code, "receipt-does-not-verify");
});

test("a receipt from before runs recorded how they started says so", async () => {
  const root = await project();
  const runs = join(root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  const { JsonlReceiptStore } = await import("../src/core/receipt-store.js");
  await new JsonlReceiptStore(join(runs, "old.jsonl")).append({ type: "workflow", terminal: true, runId: "old", status: "failed", mode: "execute" });
  const plan = await planResume({ root, receipt: "old" });
  assert.equal(plan.refusals[0].code, "no-run-start");
});

test("a file outside the project's runs is not a receipt to resume", async () => {
  const root = await project();
  await assert.rejects(planResume({ root, receipt: "/etc/passwd.jsonl" }), /one of this project's runs/);
  await assert.rejects(planResume({ root, receipt: "../x.jsonl" }), /one of this project's runs/);
});

test("the command prints the plan, and refuses to do more than plan", async () => {
  const { root, file } = await failedRun();
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    assert.equal(await runCli(["resume", file], { root, "dry-run": true, json: false, "public-key": [] }), 0);
  } finally { console.log = log; }
  const text = lines.join("\n");
  assert.match(text, /first\s+reuse/);
  assert.match(text, /second\s+run again/);
  assert.match(text, /could be resumed/);
});

test("resuming continues in the same worktree, runs only what did not finish, and the new receipt says whose steps it carried", async () => {
  const { root, file, path } = await failedRun();
  const oldEntries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const oldStart = oldEntries[0];
  const plan = await planResume({ root, receipt: file });
  assert.equal(plan.resumable, true);
  assert.deepEqual(Object.keys(plan.resume.reuse), ["first"]);

  // The provider now works; it records what the second step was asked.
  const asked = [];
  const result = await runProject({
    root,
    input: plan.resume.request.input,
    resume: plan.resume,
    providerFactories: { fake: (name) => ({ name, invoke: async ({ input }) => { asked.push(input); return { text: "second done" }; } }) },
  });
  assert.equal(result.summary.status, "succeeded");
  assert.equal(asked.length, 1, "only the step that had not finished ran");
  assert.match(asked[0], /first done/, "the carried result reached the step that needs it");
  assert.equal(result.workspace.path, oldStart.workspace.path, "the earlier worktree was continued");
  assert.equal(await readFile(join(oldStart.workspace.path, "first.txt"), "utf8"), "from the first step\n");

  const runs = join(root, ".etnpilot", "state", "runs");
  const newFile = (await readdir(runs)).filter((name) => name.endsWith(".jsonl") && name !== file)[0];
  const entries = (await readFile(join(runs, newFile), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const start = entries[0];
  assert.equal(start.resumedFrom.runId, oldStart.runId);
  assert.equal(start.resumedFrom.receiptHash, oldEntries.at(-1).hash);
  assert.deepEqual(start.resumedFrom.reusedSteps.map((entry) => entry.step), ["first"]);
  const steps = entries.filter((entry) => entry.type === "step");
  assert.equal(steps.find((entry) => entry.step === "first").reused.runId, oldStart.runId);
  assert.equal(steps.find((entry) => entry.step === "second").reused, undefined);
  assert.equal(entries.filter((entry) => entry.type === undefined && entry.workflowStep === "first").length, 0, "the first step was not run again");
  // The old receipt is untouched, and the worktree was not discarded.
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, oldEntries.length);
});

test("a run that cannot be planned is not started by the command", async () => {
  const { root, file, path } = await failedRun();
  const start = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
  await appendFile(join(start.workspace.path, "first.txt"), "edited afterwards\n");
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await runCli(["resume", file], { root, "dry-run": false, "public-key": [] }), 1);
  } finally { console.log = log; }
  assert.equal((await readdir(join(root, ".etnpilot", "state", "runs"))).filter((name) => name.endsWith(".jsonl")).length, 1, "no new run was started");
});

test("a worktree another run is working in cannot be resumed into: the plan says so and the run does not start", async () => {
  const { root, file, path } = await failedRun();
  const start = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
  const held = await acquireWorktreeLock(root, start.workspace.path, { label: "someone else" });
  try {
    const plan = await planResume({ root, receipt: file });
    assert.equal(plan.resumable, false);
    assert.ok(plan.refusals.some((refusal) => refusal.code === "workspace-in-use"));
    // The plan is re-checked by the run itself: asking for the run anyway is refused too.
    await assert.rejects(
      runProject({ root, input: "do both", resume: { from: { runId: start.runId, receiptHash: "x" }, workspace: start.workspace, reuse: {} }, providerFactories: failingSecond() }),
      /Another run is working in this worktree/,
    );
  } finally {
    await held.release();
  }
  assert.equal((await planResume({ root, receipt: file })).resumable, true, "free again once the other run is done");
});

test("the plan says why the run stopped, and what resuming amounts to when nothing can be carried over", async () => {
  const root = await project();
  const first = await runProject({ root, input: "do both", providerFactories: { fake: (name) => ({ name, invoke: async () => { throw new Error("the very first step broke"); } }) } }).then(() => undefined, (error) => error);
  assert.ok(first);
  const runs = join(root, ".etnpilot", "state", "runs");
  const [file] = (await readdir(runs)).filter((name) => name.endsWith(".jsonl"));
  const plan = await planResume({ root, receipt: file });
  assert.equal(plan.failure.step, "first");
  assert.match(plan.failure.error, /the very first step broke/);
  assert.match(plan.notes[0], /runs every step again/);
});

// The second step writes a file and edits one the first step made, then breaks:
// what a step that stopped half way leaves in the worktree.
function breakingHalfWay() {
  let calls = 0;
  return {
    fake: (name) => ({
      name,
      invoke: async ({ metadata }) => {
        calls += 1;
        if (calls === 1) {
          await writeFile(join(metadata.workspace, "first.txt"), "from the first step\n");
          return { text: "first done" };
        }
        await writeFile(join(metadata.workspace, "partial.txt"), "half of something\n");
        await appendFile(join(metadata.workspace, "first.txt"), "half an edit\n");
        throw new Error("the second step broke");
      },
    }),
  };
}

async function halfDoneRun() {
  const root = await project();
  await runProject({ root, input: "do both", providerFactories: breakingHalfWay(), cleanupWorktree: false }).then(() => undefined, () => undefined);
  const runs = join(root, ".etnpilot", "state", "runs");
  const [file] = (await readdir(runs)).filter((name) => name.endsWith(".jsonl"));
  const start = JSON.parse((await readFile(join(runs, file), "utf8")).split("\n")[0]);
  return { root, file, workspace: start.workspace.path };
}

test("what a step left half done is refused, offered for discarding, and discarded only when asked", async () => {
  const { root, file, workspace } = await halfDoneRun();

  const refused = await planResume({ root, receipt: file });
  assert.equal(refused.resumable, false);
  assert.equal(refused.refusals[0].code, "workspace-changed");
  assert.equal(refused.refusals[0].canReset, true);
  assert.match(refused.refusals[0].message, /--reset-partial/);
  assert.deepEqual(refused.resetOffer.files.map((entry) => `${entry.status} ${entry.path}`).sort(), ["removed partial.txt", "reverted first.txt"]);
  assert.equal(await readFile(join(workspace, "partial.txt"), "utf8"), "half of something\n", "planning discards nothing");

  const plan = await planResume({ root, receipt: file, resetPartial: true });
  assert.equal(plan.resumable, true);
  assert.deepEqual(plan.reset.files.map((entry) => entry.path).sort(), ["first.txt", "partial.txt"]);
  assert.equal(await readFile(join(workspace, "partial.txt"), "utf8"), "half of something\n", "a plan with a reset discards nothing either");

  // Running it: the worktree goes back before the step runs again.
  const seen = [];
  const result = await runProject({
    root,
    input: plan.resume.request.input,
    resume: plan.resume,
    providerFactories: { fake: (name) => ({ name, invoke: async ({ metadata }) => {
      seen.push({ partial: await readFile(join(metadata.workspace, "partial.txt"), "utf8").catch(() => undefined), first: await readFile(join(metadata.workspace, "first.txt"), "utf8") });
      return { text: "second done" };
    } }) },
  });
  assert.equal(result.summary.status, "succeeded");
  assert.deepEqual(seen, [{ partial: undefined, first: "from the first step\n" }], "the second step started from how the first left the worktree");
});

test("going back is refused where it could take a person's work: the main checkout, and across a commit", async () => {
  const { root, file, workspace } = await halfDoneRun();
  await git(["add", "-A"], { cwd: workspace });
  await git(["commit", "-m", "someone committed"], { cwd: workspace });
  const plan = await planResume({ root, receipt: file, resetPartial: true });
  assert.equal(plan.resumable, false);
  assert.match(plan.refusals[0].message, /cannot be put back automatically: the worktree's HEAD moved/);
  assert.equal(plan.reset, undefined);
});

test("the command lists what --reset-partial would discard, and does not discard on --dry-run", async () => {
  const { root, file, workspace } = await halfDoneRun();
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    assert.equal(await runCli(["resume", file], { root, "dry-run": true, "public-key": [] }), 1);
    assert.equal(await runCli(["resume", file], { root, "dry-run": true, "reset-partial": true, "public-key": [] }), 0);
  } finally { console.log = log; }
  const text = lines.join("\n");
  assert.match(text, /would discard \(2\)/);
  assert.match(text, /Will discard what the stopped step left/);
  assert.match(text, /removed\s+partial\.txt/);
  assert.equal(await readFile(join(workspace, "partial.txt"), "utf8"), "half of something\n");
});
