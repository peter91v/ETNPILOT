import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";
import { verifyReceiptFile } from "../src/core/receipt-store.js";
import { createReceiptVerifier, generateReceiptKeyPair } from "../src/core/receipt-signing.js";

test("project runner executes an agent and check in an isolated worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-run-"));
  await Promise.all([
    mkdir(join(root, ".etnpilot", "agents"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "prompts"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "state"), { recursive: true }),
  ]);
  const receiptKeys = await generateReceiptKeyPair({
    privateKeyPath: join(root, ".etnpilot", "keys", "receipt-signing-private.pem"),
    publicKeyPath: join(root, ".etnpilot", "receipt-signing-public.pem"),
  });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.etnpilot/keys/\n");
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
    "receipts:",
    "  signing:",
    "    enabled: true",
    "    privateKeySecret: receipt.signingKey",
    "secrets:",
    "  providers:",
    "    signing-files:",
    "      type: file",
    "      root: .etnpilot/keys",
    "  values:",
    "    receipt.signingKey: { provider: signing-files, key: receipt-signing-private.pem }",
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
          await mkdir(join(context.workingDirectory, "src"), { recursive: true });
          await writeFile(join(context.workingDirectory, "src", "generated.js"), "export const generated = true;\n");
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
  assert.deepEqual(result.codegraph.impact.changed, ["src/generated.js"]);
  assert.deepEqual(result.codegraph.impact.files.map((entry) => entry.path), ["src/generated.js"]);
  assert.match(await readFile(join(result.workspace.path, "result.txt"), "utf8"), /create result/);
  const receipts = (await readFile(result.receiptPath, "utf8")).trim().split("\n");
  assert.equal(receipts.length, 2);
  assert.equal(result.receiptProof.algorithm, "Ed25519");
  assert.equal(result.receiptProof.keyId, receiptKeys.keyId);
  const verifier = createReceiptVerifier(await readFile(receiptKeys.publicKeyPath, "utf8"));
  const verification = await verifyReceiptFile(result.receiptPath, {
    verifiers: new Map([[verifier.keyId, verifier]]),
    requireSignatures: true,
    requireTerminal: true,
  });
  assert.equal(verification.valid, true);
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

test("project runner rejects an unpublishable run before doing any work", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-publish-preflight-"));
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
    "git:",
    "  project: group/project",
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

  let invocations = 0;
  const providerFactories = {
    fake: (name) => ({ name, invoke: async () => { invocations += 1; return { text: "done" }; } }),
  };
  await assert.rejects(
    runProject({ root, input: "publish me", publish: true, env: {}, providerFactories }),
    /GitLab API token is required/,
  );
  await assert.rejects(
    runProject({ root, input: "publish me", publish: true, worktree: false, env: {}, providerFactories }),
    /Publishing an in-place run is not allowed/,
  );
  assert.equal(invocations, 0);
  const worktrees = await git(["worktree", "list", "--porcelain"], { cwd: root });
  assert.equal(worktrees.stdout.match(/^worktree /gm).length, 1);
});

test("project runner interpolates the project config with the injected environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-env-"));
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
    "  fake:",
    "    type: fake",
    "    model: ${ETNPILOT_TEST_MODEL}",
    "codegraph:",
    "  enabled: false",
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

  let seenModel;
  const result = await runProject({
    root,
    input: "check env",
    env: { ETNPILOT_TEST_MODEL: "injected-model" },
    providerFactories: {
      fake: (name, config) => {
        seenModel = config.model;
        return { name, invoke: async () => ({ text: "done" }) };
      },
    },
  });
  assert.equal(result.summary.status, "succeeded");
  assert.equal(seenModel, "injected-model");
});
