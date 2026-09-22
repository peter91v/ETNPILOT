import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";

test("project runner executes an agent and check in an isolated worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-run-"));
  await Promise.all([
    mkdir(join(root, ".etnpilot", "agents"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "prompts"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "state"), { recursive: true }),
  ]);
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, ".etnpilot", "prompts", "worker.md"), "Do the work.");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), [
    "name: worker",
    "provider: fake",
    "promptRef: worker",
    "skills: []",
    "subagents: []",
    "",
  ].join("\n"));
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "approval:",
    "  allow: [read]",
    "workflow:",
    "  concurrency: 1",
    "  steps:",
    "    - id: build",
    "      type: agent",
    "      agent: worker",
    "    - id: verify",
    "      type: check",
    `      command: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify("const fs=require('fs'); if(!fs.existsSync('result.txt')) process.exit(2)")}]`,
    "      needs: [build]",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });

  const result = await runProject({
    root,
    input: "create result",
    providerFactories: {
      fake: (name, _config, context) => ({
        name,
        async invoke(request) {
          await writeFile(join(context.workingDirectory, "result.txt"), String(request.input));
          return { text: "done" };
        },
      }),
    },
  });

  assert.equal(result.summary.status, "succeeded");
  assert.deepEqual(result.cleanup, { requested: false, removed: false, reason: "retained-by-policy" });
  assert.match(result.workspace.branch, /^etnpilot\/run-/);
  assert.match(result.git.status, /result\.txt/);
  assert.match(await readFile(join(result.workspace.path, "result.txt"), "utf8"), /create result/);
  const receipts = (await readFile(result.receiptPath, "utf8")).trim().split("\n");
  assert.equal(receipts.length, 2);
});

test("project runner can operate without a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-in-place-"));
  await Promise.all([
    mkdir(join(root, ".etnpilot", "agents"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "prompts"), { recursive: true }),
  ]);
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "prompts", "worker.md"), "Work.");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\npromptRef: worker\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake: { type: fake }",
    "workflow:",
    "  steps:",
    "    - { id: build, type: agent, agent: worker }",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });

  const result = await runProject({
    root,
    input: "in place",
    worktree: false,
    providerFactories: {
      fake: (name) => ({ name, invoke: async () => ({ text: "done" }) }),
    },
  });
  assert.equal(result.workspace.path, root);
  assert.equal(result.workspace.managed, false);
  assert.equal(result.cleanup.reason, "in-place-run");
});
