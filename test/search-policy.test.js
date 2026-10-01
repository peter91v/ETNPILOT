import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { Harness } from "../src/core/harness.js";
import { renderProjectConfig } from "../src/config/init.js";
import { git } from "../src/git/command.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";

// The first real run found search_files refused five times with 'Operation is
// denied by the default policy'. Its unit tests approved everything with a stub,
// so they could not have said so. These go through the policy a generated project
// actually has.

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-search-policy-"));
  await git(["init", "-b", "main"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "the needle is here\n");
  await writeFile(join(root, "src", "a.js"), "// needle\n");
  await writeFile(join(root, ".env"), "SECRET=needle\n");
  await writeFile(join(root, "deploy.pem"), "needle\n");
  await git(["add", "-f", "."], { cwd: root });
  return root;
}

// A harness running under the generated project's own policy.
function underGeneratedPolicy(root, capture) {
  const config = YAML.parse(renderProjectConfig("default"));
  const policy = new PolicyEngine(config.policy);
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(config.approval, { policy }),
    approvalHandler: async () => ({ kind: "reject", reason: "no human here" }),
    policy,
  });
  harness.registerProvider({
    name: "openai",
    async invoke(context) {
      const tools = createWorkspaceTools({ workingDirectory: root });
      await capture(tools, context);
      return { text: "done" };
    },
  });
  harness.registerAgent({ name: "a", provider: "openai", prompt: "x" });
  return harness;
}

test("search_files works under the policy a generated project has", async () => {
  const root = await repository();
  let result;
  await underGeneratedPolicy(root, async (tools, context) => {
    result = await tools.invoke("search_files", { pattern: "needle" }, context);
  }).run({ agent: "a", input: "go", metadata: { workspace: root } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.matches.map((match) => match.path).sort(), ["README.md", "src/a.js"]);
});

test("it does not show what read_file may not open, and says how much it left out", async () => {
  const root = await repository();
  const seen = {};
  await underGeneratedPolicy(root, async (tools, context) => {
    seen.read = await tools.invoke("read_file", { path: ".env" }, context);
    seen.search = await tools.invoke("search_files", { pattern: "needle" }, context);
    seen.names = await tools.invoke("search_files", { glob: "**/*" }, context);
  }).run({ agent: "a", input: "go", metadata: { workspace: root } });

  // The file itself is refused...
  assert.equal(seen.read.ok, false);
  assert.match(seen.read.error, /protect-credentials/);
  // ...and so is its content, by search: the same rule, not a second one.
  assert.ok(!seen.search.matches.some((match) => match.path === ".env" || match.path.endsWith(".pem")));
  assert.equal(seen.search.withheld, 2);
  // Nor are their names listed.
  assert.ok(!seen.names.files.includes(".env"));
  assert.ok(!seen.names.files.includes("deploy.pem"));
  assert.equal(seen.names.withheld, 2);
});

test("with no policy configured, nothing is withheld", async () => {
  const root = await repository();
  const tools = createWorkspaceTools({ workingDirectory: root });
  const result = await tools.invoke("search_files", { pattern: "needle" }, { approve: async () => ({ kind: "approve-once" }) });
  assert.equal(result.matches.length, 4);
  assert.equal(result.withheld, undefined);
});

test("a refusal says what it was about and which rule said no, in the record", async () => {
  const root = await repository();
  const refusals = [];
  const receipt = await underGeneratedPolicy(root, async (tools, context) => {
    refusals.push(await tools.invoke("read_file", { path: ".env" }, context));
    refusals.push(await tools.invoke("read_file", { path: "missing.txt" }, context));
  }).run({ agent: "a", input: "go", metadata: { workspace: root } });

  // A policy denial is a refusal; a missing file is not.
  assert.equal(refusals[0].refused, "policy");
  assert.equal(refusals[1].refused, undefined);
  const denied = receipt.approvals.find((entry) => entry.decision === "reject");
  assert.equal(denied.subject, "read_file .env");
  assert.match(denied.reason, /protect-credentials/);
  assert.equal(denied.policy.rule, "protect-credentials");
});
