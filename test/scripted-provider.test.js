import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { createScriptedProvider } from "../src/providers/scripted.js";
import { runProject } from "../src/runtime/project-runner.js";
import { ProviderRouter } from "../src/providers/router.js";
import { Registry } from "../src/core/registry.js";
import { PolicyEngine } from "../src/policy/engine.js";

// A project whose only provider is scripted: no SDK, no endpoint, no key.
async function scriptedProject(steps) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-scripted-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: rehearsal\nprompt: Follow the script.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  rehearsal:",
    "    type: scripted",
    `    steps: ${JSON.stringify(steps)}`,
    "    text: Scripted run finished.",
    "routing:",
    "  defaults: [rehearsal]",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    "content:",
    "  provenance:",
    "    mode: off",
    "approval:",
    "  allow: [read]",
    "  requireHuman: [write, shell, network]",
    "policy:",
    "  operations:",
    "    default: deny",
    "    rules:",
    "      - { id: read-project, effect: allow, kinds: [read], paths: ['**'] }",
    "      - { id: write-project, effect: human, kinds: [write], paths: ['**'] }",
    "  providers:",
    "    default: deny",
    "    rules:",
    "      - { id: configured, effect: allow, providers: [rehearsal] }",
    "",
  ].join("\n"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "ETNPilot Test"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) await git(args, { cwd: root });
  return root;
}

test("a project can be exercised with no provider account at all", async () => {
  const root = await scriptedProject([
    { tool: "list_files", arguments: { path: "." } },
    { tool: "write_file", arguments: { path: "NOTES.md", content: "Written by a scripted run.\n" } },
  ]);

  const decided = [];
  const result = await runProject({
    root,
    input: "run the script",
    approvalHandler: async (request) => {
      decided.push(request.kind);
      return { kind: "approve-once", evidence: { decidedBy: "test" } };
    },
  });

  assert.equal(result.summary.status, "succeeded");
  // The declared steps went through the real approval path, not around it.
  assert.deepEqual(decided, ["write"]);
  assert.equal(
    await readFile(join(result.workspace.path, "NOTES.md"), "utf8"),
    "Written by a scripted run.\n",
  );
  // Nothing here is a model, and the receipt says so rather than implying one.
  const receipt = await readFile(result.receiptPath, "utf8");
  assert.match(receipt, /"model":"scripted"/);
  assert.match(receipt, /"provider":"rehearsal"/);
});

test("a refused step fails the run instead of reporting success over a denial", async () => {
  const root = await scriptedProject([
    { tool: "write_file", arguments: { path: "NOTES.md", content: "never written\n" } },
  ]);

  await assert.rejects(
    runProject({
      root,
      input: "run the script",
      approvalHandler: async () => ({ kind: "reject", reason: "Not now." }),
    }),
    /Scripted step 1 \(write_file\) did not run/,
  );
});

test("a scripted provider refuses a step it cannot perform, at configuration time", () => {
  assert.throws(
    () => createScriptedProvider({ workingDirectory: "/tmp", steps: [{ tool: "rm_rf" }] }),
    /step 0 has tool 'rm_rf'\. Available: read_file, list_files, write_file, run_command\./,
  );
  assert.throws(
    () => createScriptedProvider({ workingDirectory: "/tmp", steps: ["write NOTES.md"] }),
    /step 0 must be a mapping/,
  );
  assert.throws(() => createScriptedProvider({ steps: [] }), /requires a workingDirectory/);
});

test("when every provider is passed over, the message names why", async () => {
  const registry = new Registry("provider");
  registry.register("rehearsal", { name: "rehearsal", capabilities: ["chat"], invoke: () => ({ text: "x" }) });
  const router = new ProviderRouter(
    registry,
    { defaults: ["rehearsal"] },
    { policy: new PolicyEngine({ providers: { default: "deny", rules: [] } }) },
  );

  await assert.rejects(
    router.invoke({ agent: { name: "worker", requires: ["chat"] }, input: "x" }),
    (error) => {
      // Without this, the message blames capabilities and sends people to the
      // agent manifest, when the answer is in policy.providers.
      assert.match(error.message, /'rehearsal' denied by policy\.providers/);
      assert.equal(error.code, "no_eligible_provider");
      return true;
    },
  );
});
