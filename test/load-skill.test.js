import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createResultEnvelope } from "../src/providers/tool-results.js";
import { createWorkspaceTools, skillSummary } from "../src/providers/workspace-tools.js";

// P4.2: a skill costs its name and one line until the agent opens it.

const skills = [
  { name: "release", content: "---\nname: release\ndescription: How a release is cut here.\n---\n# Release\nSTEP-ONE-OF-RELEASE" },
  { name: "style", content: "# Style\n\nKeep functions short.\nMORE-STYLE-RULES" },
];

test("the summary is the description, else the first line of prose", () => {
  assert.equal(skillSummary(skills[0].content), "How a release is cut here.");
  assert.equal(skillSummary(skills[1].content), "Keep functions short.");
  assert.equal(skillSummary(""), "(no description)");
});

test("load_skill is offered only to an agent that has skills and may use it", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "etn-skill-"));
  const names = (options) => createWorkspaceTools({ workingDirectory, ...options }).definitions.map((d) => d.name);
  assert.ok(!names({}).includes("load_skill"));
  assert.ok(names({ skills }).includes("load_skill"));
  assert.ok(!names({ skills, allowed: ["read_file"] }).includes("load_skill"));
});

test("the text arrives on request, beside the result and not inside the data envelope", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "etn-skill-"));
  const tools = createWorkspaceTools({ workingDirectory, skills });
  const result = await tools.invoke("load_skill", { name: "release" }, {});
  assert.equal(result.ok, true);
  const text = createResultEnvelope("r").render(result);
  assert.ok(text.indexOf("STEP-ONE-OF-RELEASE") > text.lastIndexOf("</tool_output"));
  const missing = await tools.invoke("load_skill", { name: "nope" }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /release, style/);
});

function recordingProvider(options = {}) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }], model: "m", usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const provider = createAnthropicProvider({ apiKey: "k", fetchImpl, tools: true, workingDirectory: tmpdir(), ...options });
  return { provider, bodies };
}

const context = (agent) => ({
  runId: "r", agent, input: "go", instructions: [], skills, approve: async () => ({ kind: "approve-once" }),
});

test("the system prompt lists the skills instead of carrying them, and is shorter for it", async () => {
  const lazy = recordingProvider();
  await lazy.provider.invoke(context({ name: "a", prompt: "P" }));
  const listed = JSON.stringify(lazy.bodies[0].system);
  assert.match(listed, /release: How a release is cut here\./);
  assert.match(listed, /style: Keep functions short\./);
  assert.doesNotMatch(listed, /STEP-ONE-OF-RELEASE|MORE-STYLE-RULES/);

  // An agent that cannot load them gets them whole: a skill it can neither see
  // nor open would be a skill it does not have.
  const eager = recordingProvider();
  await eager.provider.invoke(context({ name: "a", prompt: "P", tools: ["read_file"] }));
  assert.match(JSON.stringify(eager.bodies[0].system), /STEP-ONE-OF-RELEASE/);
});

test("the full text is in the conversation only after the call", async () => {
  const bodies = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "load_skill", input: { name: "release" } }] },
    { content: [{ type: "text", text: "done" }] },
  ];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ...replies.shift(), model: "m", usage: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const provider = createAnthropicProvider({ apiKey: "k", fetchImpl, tools: true, workingDirectory: tmpdir() });
  await provider.invoke(context({ name: "a", prompt: "P" }));
  assert.doesNotMatch(JSON.stringify(bodies[0]), /STEP-ONE-OF-RELEASE/);
  assert.match(JSON.stringify(bodies[1].messages), /STEP-ONE-OF-RELEASE/);
});
