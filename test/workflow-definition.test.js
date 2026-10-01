import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { captureProjectContent, writeContentLock, verifyProjectContent } from "../src/content/provenance.js";
import { renderWorkflowFile, validateWorkflowDefinition } from "../src/workflow/definition.js";

const AGENTS = ["planner", "builder", "reviewer"];

test("a good workflow is cleaned to the fields a step uses", () => {
  const result = validateWorkflowDefinition({
    name: "Plan Build Review",
    description: "  A careful change  ",
    steps: [
      { id: "plan", type: "agent", agent: "planner", junk: "dropped" },
      { id: "ok", type: "gate", needs: ["plan"], prompt: "Go on?" },
      { id: "build", type: "agent", agent: "builder", needs: ["ok"], expect: "tool-use" },
      { id: "tests", type: "check", command: "npm test", needs: ["build"] },
      { id: "review", type: "quorum", agents: ["planner", "reviewer"], required: 2, needs: ["tests"] },
    ],
  }, { agents: AGENTS });
  assert.equal(result.ok, true, result.errors.join(" "));
  assert.equal(result.workflow.name, "plan-build-review");
  assert.equal(result.workflow.description, "A careful change");
  assert.deepEqual(result.workflow.steps[3].command, ["npm", "test"]);
  assert.equal(result.workflow.steps[0].junk, undefined);
});

test("what is wrong is said in the words of the step", () => {
  const bad = (steps, name = "x") => validateWorkflowDefinition({ name, steps }, { agents: AGENTS }).errors.join(" | ");
  assert.match(bad([]), /at least one step/);
  assert.match(validateWorkflowDefinition({ steps: [{ id: "a", agent: "planner" }] }, { agents: AGENTS }).errors.join(), /needs a name/);
  assert.match(bad([{ id: "a", type: "agent", agent: "ghost" }]), /'a' names the agent 'ghost', which does not exist/);
  assert.match(bad([{ id: "a", type: "agent" }]), /'a' needs an agent/);
  assert.match(bad([{ id: "a", agent: "planner" }, { id: "a", agent: "planner" }]), /Two steps are called 'a'/);
  assert.match(bad([{ id: "a", agent: "planner", needs: ["zzz"] }]), /needs 'zzz'/);
  assert.match(bad([{ id: "a", agent: "planner", needs: ["b"] }, { id: "b", agent: "planner", needs: ["a"] }]), /circle/);
  assert.match(bad([{ id: "a", type: "check", command: "" }]), /needs a command/);
  assert.match(bad([{ id: "a", type: "quorum", agents: ["planner"] }]), /at least two agents/);
  assert.match(bad([{ id: "a", type: "agent", agent: "planner", expect: "magic" }]), /only expectation is 'tool-use'/);
  assert.match(bad([{ id: "a", type: "teleport" }]), /type 'teleport'/);
  assert.match(bad([{ id: "Bad Id!", agent: "planner" }]), /needs an id/);
});

test("workflow files are project content: pinned, and unreviewed until locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-wf-"));
  await initializeProject(root, { forge: false, importExisting: false });
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  await writeContentLock(root, config);
  await verifyProjectContent(root, config);

  await mkdir(join(root, ".etnpilot/workflows"), { recursive: true });
  await writeFile(join(root, ".etnpilot/workflows/careful.yaml"), renderWorkflowFile({ name: "careful", steps: [{ id: "a", type: "agent", agent: "orchestrator" }] }));
  const snapshot = await captureProjectContent(root, {});
  assert.ok(snapshot.items.some((item) => item.type === "workflow" && item.name === "careful"));
  await assert.rejects(() => verifyProjectContent(root, config), /unreviewed|lock/i);
  await writeContentLock(root, config);
  await verifyProjectContent(root, config);
});

test("a run can be told which named workflow to follow, and says so in the receipt", async () => {
  const { git } = await import("../src/git/command.js");
  const { runProject } = await import("../src/runtime/project-runner.js");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-named-"));
  await Promise.all([
    mkdir(join(root, ".etnpilot", "agents"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "prompts"), { recursive: true }),
    mkdir(join(root, ".etnpilot", "workflows"), { recursive: true }),
  ]);
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n");
  for (const name of ["first", "second"]) {
    await writeFile(join(root, ".etnpilot/prompts", `${name}.md`), name);
    await writeFile(join(root, ".etnpilot/agents", `${name}.yaml`), `name: ${name}\nprovider: fake\npromptRef: ${name}\n`);
  }
  await writeFile(join(root, ".etnpilot/etnpilot.yaml"), "version: 1\ndefaultAgent: first\nproviders:\n  fake: { type: fake }\ncontent:\n  provenance: { mode: off }\n");
  await writeFile(join(root, ".etnpilot/workflows/both.yaml"), renderWorkflowFile({
    name: "both",
    steps: [{ id: "one", type: "agent", agent: "first" }, { id: "two", type: "agent", agent: "second", needs: ["one"] }],
  }));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "t@e.x"], { cwd: root });
  await git(["config", "user.name", "t"], { cwd: root });
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "x"], { cwd: root });

  const seen = [];
  const providerFactories = { fake: (name) => ({ name, invoke: async (context) => { seen.push(context.agent.name); return { text: "ok" }; } }) };
  const result = await runProject({ root, input: "go", workflow: "both", providerFactories });
  assert.deepEqual(seen, ["first", "second"]);
  const sealed = (await readFile(result.receiptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).findLast((entry) => entry.terminal);
  assert.equal(sealed.workflow, "both");

  await assert.rejects(() => runProject({ root, input: "go", workflow: "nope", providerFactories }), /no workflow called 'nope'.*both/);
});
