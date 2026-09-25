import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { createWorkspaceTools, WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { Harness } from "../src/core/harness.js";
import { initializeProject } from "../src/config/init.js";

// P1.5: least privilege. 'requires:' is a floor — 'the provider must be able
// to do at least this' — and the tools hung on the provider, so every agent
// sharing one got all of them, reviewer included.

const context = (name, overrides = {}) => ({
  agent: { name, prompt: "Do the work.", tools: overrides.tools },
  input: "go",
  instructions: [],
  skills: [],
  approve: async () => ({ kind: "approve-once" }),
  ...overrides,
});

test("an agent is offered only its own tools, and refused the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-privilege-"));
  await writeFile(join(root, "code.js"), "original\n");
  const reviewer = createWorkspaceTools({
    workingDirectory: root,
    allowed: ["read_file", "list_files", "search_files", "run_command"],
  });

  // Offered: the model never sees the others.
  assert.deepEqual(reviewer.definitions.map((definition) => definition.name),
    ["read_file", "list_files", "search_files", "run_command"]);

  // And enforced, because a model can name a tool nobody showed it. An offer
  // is not a boundary.
  const refused = await reviewer.invoke("write_file", { path: "code.js", content: "changed" }, context("reviewer"));
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "not-allowed");
  assert.match(refused.error, /Agent 'reviewer' may not use 'write_file'/);
  assert.equal(await readFile(join(root, "code.js"), "utf8"), "original\n");

  const edit = await reviewer.invoke("edit_file", { path: "code.js", old_string: "original", new_string: "changed" }, context("reviewer"));
  assert.equal(edit.refused, "not-allowed");
  assert.equal(await readFile(join(root, "code.js"), "utf8"), "original\n");

  // What it may do, it still does.
  assert.equal((await reviewer.invoke("read_file", { path: "code.js" }, context("reviewer"))).ok, true);

  // A tool that does not exist at all is a different answer from one this
  // agent may not use: the receipt should say which.
  const unknown = await reviewer.invoke("delete_everything", {}, context("reviewer"));
  assert.match(unknown.error, /Unknown tool/);
  assert.equal(unknown.refused, undefined);
});

test("no list means every tool, which is what every agent had before", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-privilege-all-"));
  const tools = createWorkspaceTools({ workingDirectory: root });
  assert.deepEqual(tools.definitions, WORKSPACE_TOOL_DEFINITIONS);
});

test("the provider offers the agent's list, not the provider's", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-privilege-provider-"));
  const bodies = [];
  const provider = createAnthropicProvider({
    apiKey: "sk-test",
    tools: true,
    workingDirectory: root,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
    },
  });

  await provider.invoke(context("reviewer", { tools: ["read_file", "search_files"] }));
  assert.deepEqual(bodies[0].tools.map((tool) => tool.name), ["read_file", "search_files"]);

  // The same provider, a different agent: the tools follow the agent.
  await provider.invoke(context("builder"));
  assert.equal(bodies[1].tools.length, WORKSPACE_TOOL_DEFINITIONS.length);
});

test("a misspelt tool name is refused when the agent is registered", () => {
  const harness = new Harness();
  const agent = { name: "typo", prompt: "p", provider: "stub", tools: ["read_file", "wrte_file"] };
  // Otherwise it reads as 'this agent may use nothing', which looks like a
  // model that refuses to work.
  assert.throws(() => harness.registerAgent(agent), /lists tools that do not exist: wrte_file/);
  assert.throws(() => harness.registerAgent({ ...agent, tools: "read_file" }), /must be a list of tool names/);
  assert.equal(harness.registerAgent({ ...agent, tools: ["read_file"] }).name, "typo");
});

test("a generated project ships each role with the tools that role needs", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-privilege-init-"));
  await initializeProject(root);
  const manifest = YAML.parse(await readFile(join(root, ".etnpilot", "agents", "orchestrator.yaml"), "utf8"));
  assert.equal(Array.isArray(manifest.tools), true, "the field is there to be narrowed");

  // And this project's own agents, which is where it matters today.
  const own = async (name) => YAML.parse(await readFile(new URL(`../.etnpilot/agents/${name}.yaml`, import.meta.url), "utf8"));
  const reviewer = await own("reviewer");
  assert.equal(reviewer.tools.includes("write_file"), false, "a reviewer that can edit the code it reviews is not a reviewer");
  assert.equal(reviewer.tools.includes("edit_file"), false);
  assert.equal(reviewer.tools.includes("run_command"), true, "it still runs the checks");

  const orchestrator = await own("orchestrator");
  assert.equal(orchestrator.tools.includes("write_file"), false, "a planner that writes skipped the plan");

  const builder = await own("builder");
  assert.equal(builder.tools.includes("edit_file"), true);
  assert.equal(builder.tools.includes("write_file"), true);
});
