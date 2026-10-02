import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriage, runLadder, startTier } from "../src/workflow/ladder.js";
import { validateWorkflowDefinition } from "../src/workflow/definition.js";

const tiers = [{ model: "cheap", effort: "low" }, { model: "mid", effort: "medium" }, { model: "strong", effort: "high" }];
const step = { id: "build", type: "ladder", agent: "builder", tiers, verify: [{ command: ["npm", "test"] }] };
const receipt = (cost, text = "done") => ({ runId: `r-${cost}`, result: { text }, usage: { estimatedCost: cost, inputTokens: 100, outputTokens: 10 } });

function deps({ passAt, tested = [], records = [] }) {
  return {
    input: "task",
    record: async (entry) => { records.push(entry); },
    runAgent: async (tier, text) => { tested.push({ model: tier.model, text }); return receipt({ cheap: 0.01, mid: 0.05, strong: 0.25 }[tier.model]); },
    verifyCommand: async () => ({ ok: tested.length >= passAt, detail: `tests failed after ${tested.at(-1).model}` }),
    runReviewer: async () => receipt(0.02, "VERDICT: approve"),
  };
}

test("the cheap tier is enough when it passes, and the stronger ones are never called", async () => {
  const tested = [];
  const result = await runLadder(step, deps({ passAt: 1, tested }));
  assert.deepEqual(tested.map((entry) => entry.model), ["cheap"]);
  assert.equal(result.ladder.passed, true);
  assert.equal(result.ladder.cost, 0.01);
});

test("a failed verification climbs one tier with the failure as feedback, and the cost adds up", async () => {
  const tested = [];
  const records = [];
  const result = await runLadder(step, deps({ passAt: 3, tested, records }));
  assert.deepEqual(tested.map((entry) => entry.model), ["cheap", "mid", "strong"]);
  assert.doesNotMatch(tested[0].text, /did not pass/);
  assert.match(tested[1].text, /tests failed after cheap/);
  assert.equal(Number(result.ladder.cost.toFixed(2)), 0.31);
  assert.deepEqual(result.ladder.attempts.map((attempt) => attempt.status), ["failed", "failed", "passed"]);
  assert.deepEqual(records.map((entry) => entry.type), ["ladder-attempt", "ladder-attempt", "ladder-attempt"]);
});

test("a ladder that never passes fails the step and says what each tier cost", async () => {
  const tested = [];
  await assert.rejects(runLadder(step, deps({ passAt: 99, tested })), (error) => {
    assert.equal(error.code, "ladder_exhausted");
    assert.equal(error.ladder.attempts.length, 3);
    assert.equal(error.ladder.passed, false);
    return true;
  });
  await assert.rejects(runLadder({ ...step, maxAttempts: 2 }, deps({ passAt: 99, tested: [] })), (error) => error.ladder.attempts.length === 2);
});

test("an agent that stops with an error counts as a failed tier, not a crashed run", async () => {
  const calls = [];
  const result = await runLadder(step, {
    ...deps({ passAt: 1 }),
    runAgent: async (tier) => { calls.push(tier.model); if (tier.model === "cheap") throw new Error("rate limited"); return receipt(0.05); },
    verifyCommand: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, ["cheap", "mid"]);
  assert.equal(result.ladder.attempts[0].status, "error");
});

test("a reviewer's reject sends the task up, and silence is not approval", async () => {
  const reviewStep = { ...step, verify: [{ reviewer: "reviewer" }] };
  const verdicts = ["VERDICT: reject\nmissing tests", "no verdict at all", "VERDICT: approve"];
  const result = await runLadder(reviewStep, { ...deps({ passAt: 1 }), runReviewer: async () => receipt(0.02, verdicts.shift()) });
  assert.deepEqual(result.ladder.attempts.map((attempt) => attempt.status), ["failed", "failed", "passed"]);
});

test("the router picks the first rung and how hard to verify; a bad answer never skips checking", async () => {
  assert.deepEqual(parseTriage('{"difficulty":"complex","risk":"low"}'), { difficulty: "complex", risk: "low", reason: undefined });
  assert.deepEqual(parseTriage("I think it is hard"), { difficulty: "unknown", risk: "high", reason: undefined });
  assert.deepEqual([startTier({ difficulty: "simple" }, 3), startTier({ difficulty: "medium" }, 3), startTier({ difficulty: "complex" }, 3)], [0, 1, 2]);

  const tested = [];
  const records = [];
  const light = { ...step, router: { agent: "triage" }, verifyLight: [{ command: ["node", "--check", "x.js"] }], verify: [{ command: ["npm", "test"] }] };
  const verified = [];
  const result = await runLadder(light, {
    ...deps({ passAt: 1, tested, records }),
    runTriage: async () => receipt(0.001, '{"difficulty":"complex","risk":"low","reason":"api change"}'),
    verifyCommand: async (verifier) => { verified.push(verifier.command[0]); return { ok: true }; },
  });
  assert.deepEqual(tested.map((entry) => entry.model), ["strong"]);
  assert.deepEqual(verified, ["node"], "low risk verifies lightly");
  assert.equal(result.ladder.route.verify, "light");
  assert.equal(records[0].type, "ladder-route");
  const unclear = await runLadder(light, { ...deps({ passAt: 1, tested: [] }), runTriage: async () => receipt(0, "no idea"), verifyCommand: async (verifier) => { verified.push(verifier.command[0]); return { ok: true }; } });
  assert.equal(unclear.ladder.route.verify, "full");
});

test("a ladder in a workflow file is checked in the words of the step", () => {
  const agents = ["builder", "reviewer", "triage"];
  const good = validateWorkflowDefinition({ name: "w", steps: [{ id: "build", type: "ladder", agent: "builder", tiers, verify: [{ command: "npm test" }, { reviewer: "reviewer" }], router: { agent: "triage" } }] }, { agents });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.workflow.steps[0].verify[0].command, ["npm", "test"]);
  const bad = validateWorkflowDefinition({ name: "w", steps: [{ id: "build", type: "ladder", agent: "ghost", tiers: [{}, { effort: "max" }], verify: [{ reviewer: "nobody" }], router: {} }] }, { agents });
  assert.equal(bad.ok, false);
  const text = bad.errors.join("\n");
  for (const part of [/'ghost'/, /changes nothing/, /effort/, /nobody/, /router/]) assert.match(text, part);
  assert.match(validateWorkflowDefinition({ name: "w", steps: [{ id: "b", type: "ladder", agent: "builder", tiers }] }, { agents }).errors.join(), /something to verify with/);
});

test("a ladder runs inside a real workflow run: tiers are the same agent with another model, and the receipt keeps each attempt", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { git } = await import("../src/git/command.js");
  const { runProject } = await import("../src/runtime/project-runner.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ladder-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  await writeFile(join(root, ".etnpilot", "agents", "builder.yaml"), "name: builder\nprovider: fake\nmodel: base\nprompt: Build it.\n");
  await writeFile(join(root, ".etnpilot", "agents", "reviewer.yaml"), "name: reviewer\nprovider: fake\nprompt: Review it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "providers:", "  fake:", "    type: fake", "content:", "  provenance:", "    mode: off",
    "codegraph:", "  enabled: false", "observability:", "  enabled: false", "workflow:", "  steps:",
    "    - id: build", "      type: ladder", "      agent: builder", "      tiers:",
    "        - { model: cheap-model, effort: low }", "        - { model: strong-model, effort: high }",
    "      verify: [{ reviewer: reviewer }]", "",
  ].join("\n"));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });

  const built = [];
  let reviews = 0;
  const factories = {
    fake: (name) => ({
      name,
      invoke: async (context) => {
        if (context.agent.name === "reviewer") { reviews += 1; return { text: reviews === 1 ? "Not good.\nVERDICT: reject" : "Fine.\nVERDICT: approve" }; }
        built.push([context.agent.name, context.agent.model, context.agent.effort]);
        return { text: "built" };
      },
    }),
  };
  const run = await runProject({ root, input: "make it", providerFactories: factories });
  assert.equal(run.summary.status, "succeeded");
  assert.deepEqual(built, [["builder.build-t1", "cheap-model", "low"], ["builder.build-t2", "strong-model", "high"]]);
  const ladder = run.summary.steps.build.result.ladder;
  assert.deepEqual(ladder.attempts.map((attempt) => [attempt.tier, attempt.model, attempt.status]), [[1, "cheap-model", "failed"], [2, "strong-model", "passed"]]);
  const entries = (await readFile(join(root, ".etnpilot", "state", "runs", `${run.runId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.type === "ladder-attempt").length, 2);
});
