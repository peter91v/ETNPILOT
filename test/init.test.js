import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { PolicyEngine } from "../src/policy/engine.js";

test("init keeps run state and worktrees out of the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-init-"));
  await git(["init", "-b", "main"], { cwd: root });
  await initializeProject(root);

  const ignore = await readFile(join(root, ".etnpilot", ".gitignore"), "utf8");
  assert.match(ignore, /^state\/$/m);
  assert.match(ignore, /^worktrees\/$/m);
  assert.match(ignore, /^keys\/$/m);
  assert.match(ignore, /^secrets\/$/m);

  await writeFile(join(root, ".etnpilot", "state", "run.jsonl"), "{}\n");
  await writeFile(join(root, ".etnpilot", "state", "cache.sqlite"), "");
  const status = await git(["status", "--porcelain"], { cwd: root });
  assert.equal(status.stdout.includes(".etnpilot/state"), false, status.stdout);

  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const policy = new PolicyEngine(config.policy);
  assert.equal(policy.evaluateOperation({ kind: "read", fileName: "src/index.js" }, { workspace: root }).kind, "approve-once");
  assert.equal(policy.evaluateOperation({ kind: "read", fileName: ".env" }, { workspace: root }).kind, "reject");
  assert.equal(policy.evaluateProvider("github-copilot").allowed, true);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.otlp.enabled, false);
  assert.equal(config.pluginIsolation.memoryMb, 128);
  assert.equal(config.pluginIsolation.callTimeoutMs, 30000);
  assert.equal(config.codegraph.enabled, true);
  assert.deepEqual(config.codegraph.tools, ["codegraph_explore"]);
  assert.equal(config.content.provenance.mode, "enforce");
  assert.equal(config.content.provenance.lockFile, ".etnpilot/content-lock.json");
  assert.equal(config.content.provenance.verifyAfterRun, true);
  assert.equal(config.checks.envAllow.length, 0);
  assert.deepEqual(config.git.issueTrigger.allowedUsers, []);

  // A fresh project is runnable: the default agent exists and has a prompt.
  const agent = await readFile(join(root, ".etnpilot", "agents", "orchestrator.yaml"), "utf8");
  assert.match(agent, /^name: orchestrator$/m);
  assert.match(agent, /^promptRef: orchestrator$/m);
  assert.match(await readFile(join(root, ".etnpilot", "prompts", "orchestrator.md"), "utf8"), /one requested change/);

  // Governance files are protected from the agent by default.
  assert.equal(policy.evaluateOperation({
    kind: "write",
    fileName: ".etnpilot/etnpilot.yaml",
  }, { workspace: root }).kind, "reject");
  assert.equal(policy.evaluateOperation({
    kind: "write",
    fileName: ".github/workflows/ci.yml",
  }, { workspace: root }).kind, "reject");
  assert.equal(policy.evaluateOperation({
    kind: "write",
    fileName: "src/index.js",
  }, { workspace: root }).kind, "human-required");
});

test("init never overwrites an existing configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-init-existing-"));
  await initializeProject(root);
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\ncustom: true\n");
  await writeFile(join(root, ".etnpilot", ".gitignore"), "custom-ignore\n");
  await writeFile(join(root, ".etnpilot", "agents", "orchestrator.yaml"), "name: mine\n");

  await initializeProject(root);
  assert.equal(await readFile(join(root, ".etnpilot", "agents", "orchestrator.yaml"), "utf8"), "name: mine\n");
  assert.match(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"), /custom: true/);
  assert.equal(await readFile(join(root, ".etnpilot", ".gitignore"), "utf8"), "custom-ignore\n");
});
