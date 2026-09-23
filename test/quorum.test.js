import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { runProject } from "../src/runtime/project-runner.js";
import { evaluateQuorum, parseVerdict } from "../src/workflow/quorum.js";

test("a verdict must be stated; silence abstains", () => {
  assert.equal(parseVerdict("Looks fine to me.\n\nVERDICT: approve"), "approve");
  assert.equal(parseVerdict("VERDICT: reject\nThe migration is unsafe."), "reject");
  assert.equal(parseVerdict("> **VERDICT:** approve"), "approve");
  assert.equal(parseVerdict("I think this is probably fine"), "abstain");
  assert.equal(parseVerdict(undefined), "abstain");
});

test("quorum arithmetic discounts correlated reviewers", () => {
  const twoProviders = evaluateQuorum([
    { agent: "a", provider: "copilot", verdict: "approve" },
    { agent: "b", provider: "backup", verdict: "approve" },
  ], { required: 2 });
  assert.equal(twoProviders.satisfied, true);
  assert.deepEqual(twoProviders.providers, ["backup", "copilot"]);

  // Two reviewers on one provider are one opinion with two voices.
  const sameProvider = evaluateQuorum([
    { agent: "a", provider: "copilot", verdict: "approve" },
    { agent: "b", provider: "copilot", verdict: "approve" },
  ], { required: 2 });
  assert.equal(sameProvider.satisfied, false);
  assert.equal(sameProvider.approvals, 1);
  assert.equal(sameProvider.discounted[0].reason, "duplicate-provider");
  assert.equal(evaluateQuorum([
    { agent: "a", provider: "copilot", verdict: "approve" },
    { agent: "b", provider: "copilot", verdict: "approve" },
  ], { required: 2, distinctProviders: false }).satisfied, true);

  // One rejection blocks, regardless of how many approved.
  const rejected = evaluateQuorum([
    { agent: "a", provider: "one", verdict: "approve" },
    { agent: "b", provider: "two", verdict: "approve" },
    { agent: "c", provider: "three", verdict: "reject" },
  ], { required: 2 });
  assert.equal(rejected.satisfied, false);
  assert.equal(rejected.rejections, 1);

  // The default is a simple majority.
  assert.equal(evaluateQuorum([
    { agent: "a", provider: "one", verdict: "approve" },
    { agent: "b", provider: "two", verdict: "approve" },
    { agent: "c", provider: "three", verdict: "abstain" },
  ]).satisfied, true);
});

test("a workflow quorum step gates the run", async () => {
  const verdicts = new Map([["reviewer-a", "approve"], ["reviewer-b", "approve"]]);
  const root = await createProject();
  const factories = {
    fake: (name) => ({
      name,
      invoke: async (context) => ({ text: `Reviewed.\nVERDICT: ${verdicts.get(context.agent.name)}` }),
    }),
    other: (name) => ({
      name,
      invoke: async (context) => ({ text: `Reviewed.\nVERDICT: ${verdicts.get(context.agent.name)}` }),
    }),
  };

  const approved = await runProject({ root, input: "review this", providerFactories: factories });
  assert.equal(approved.summary.status, "succeeded");
  const outcome = approved.summary.steps.review.result;
  assert.equal(outcome.satisfied, true);
  assert.deepEqual(outcome.providers, ["backup", "fake"]);
  assert.deepEqual(outcome.votes.map((vote) => vote.verdict), ["approve", "approve"]);

  verdicts.set("reviewer-b", "reject");
  const blocked = await runProject({ root, input: "review this", providerFactories: factories })
    .catch((error) => error);
  assert.equal(blocked.code, "quorum_not_reached");
  assert.match(blocked.message, /1 reviewer\(s\) rejected/);
  assert.equal(blocked.run.summary.status, "failed");
});

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-quorum-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  for (const [name, provider] of [["reviewer-a", "fake"], ["reviewer-b", "backup"]]) {
    await writeFile(join(root, ".etnpilot", "agents", `${name}.yaml`), [
      `name: ${name}`,
      `provider: ${provider}`,
      "prompt: Review the change.",
      "",
    ].join("\n"));
  }
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "providers:",
    "  fake:",
    "    type: fake",
    "  backup:",
    "    type: other",
    "content:",
    "  provenance:",
    "    mode: off",
    "codegraph:",
    "  enabled: false",
    "observability:",
    "  enabled: false",
    "workflow:",
    "  steps:",
    "    - id: review",
    "      type: quorum",
    "      agents: [reviewer-a, reviewer-b]",
    "      required: 2",
    "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}
