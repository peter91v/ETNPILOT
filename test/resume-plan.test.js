import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/commands.js";
import { git } from "../src/git/command.js";
import { planResume } from "../src/runtime/resume-plan.js";
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
  await assert.rejects(runCli(["resume", file], { root, "dry-run": false, "public-key": [] }), /not built yet/);
});
