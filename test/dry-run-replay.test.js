import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";
import { replayRun } from "../src/runtime/replay.js";

test("a dry run evaluates policy but changes nothing", async () => {
  const root = await createProject();
  const attempted = [];

  const result = await runProject({
    root,
    input: "write a file",
    dryRun: true,
    providerFactories: {
      fake: (name) => ({
        name,
        async invoke(context) {
          const decision = await context.approve({ kind: "write", fileName: "generated.txt" });
          attempted.push(decision);
          return { text: decision.kind };
        },
      }),
    },
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.summary.status, "succeeded");
  assert.equal(attempted[0].kind, "reject");
  assert.equal(attempted[0].dryRun, true);
  // Policy still ran, so the record shows what would have been required.
  assert.equal(attempted[0].wouldBe, "human-required");
  await assert.rejects(() => readFile(join(result.workspace.path, "generated.txt")));

  // The check was recorded, not executed.
  const checkStep = result.summary.steps.verify;
  assert.equal(checkStep.result.skipped, true);
  assert.equal(checkStep.result.reason, "dry-run");
  await assert.rejects(() => readFile(join(result.workspace.path, "check-ran.txt")));

  const receipt = await readFile(result.receiptPath, "utf8");
  assert.match(receipt, /"mode":"dry-run"/);
});

test("a dry run refuses to publish", async () => {
  const root = await createProject();
  await assert.rejects(
    () => runProject({ root, input: "x", dryRun: true, publish: true, providerFactories: {} }),
    /A dry run cannot publish\./,
  );
});

test("replay re-runs recorded checks and reports drift", async () => {
  const root = await createProject();
  const result = await runProject({
    root,
    input: "do the work",
    providerFactories: {
      fake: (name) => ({ name, invoke: async () => ({ text: "done" }) }),
    },
  });
  assert.equal(result.summary.status, "succeeded");

  const workspace = result.workspace.path;
  const matching = await replayRun(result.receiptPath, { root: workspace });
  assert.equal(matching.receiptValid, true);
  assert.equal(matching.runId, result.runId);
  assert.equal(matching.mode, "execute");
  assert.deepEqual(matching.drifted, []);
  assert.equal(matching.checks[0].verdict, "matches");

  // Break what the check verified: the replay must notice.
  await writeFile(join(workspace, "marker.txt"), "changed\n");
  const drifted = await replayRun(result.receiptPath, { root: workspace });
  assert.deepEqual(drifted.drifted, ["verify"]);
  assert.equal(drifted.checks[0].recorded.exitCode, 0);
  assert.equal(drifted.checks[0].replayed.status, "failed");
});

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-dry-replay-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, "marker.txt"), "expected\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), [
    "name: worker",
    "provider: fake",
    "prompt: Do the work.",
    "",
  ].join("\n"));
  const verify = [
    "const fs = require('fs');",
    "fs.writeFileSync('check-ran.txt', 'yes');",
    "if (fs.readFileSync('marker.txt', 'utf8') !== 'expected\\n') process.exit(4);",
  ].join(" ");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "content:",
    "  provenance:",
    "    mode: off",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    "workflow:",
    "  steps:",
    "    - id: build",
    "      type: agent",
    "      agent: worker",
    "    - id: verify",
    "      type: check",
    `      command: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(verify)}]`,
    "      needs: [build]",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}
