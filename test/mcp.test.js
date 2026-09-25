import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connectMcpTools, createMcpClient } from "../src/providers/mcp-client.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { PolicyEngine } from "../src/policy/engine.js";

// P3.2: MCP for every provider, over the real protocol, through the same
// approval path as everything else. It used to be one hardcoded server handed
// to one adapter.

const server = () => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("./helpers/mcp-server.mjs", import.meta.url))],
});

const approve = (recorder) => ({
  agent: { name: "builder" },
  approve: async (request) => {
    recorder?.push(request);
    return { kind: "approve-once" };
  },
});

test("a server is spoken to, not described", async () => {
  const client = createMcpClient({ name: "fixture", ...server() });
  try {
    const initialized = await client.initialize();
    assert.equal(initialized.serverInfo.name, "fixture");
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["shout", "explode"]);
    // The schema the server declares becomes the schema the model is given.
    assert.deepEqual(tools[0].parameters.required, ["text"]);
    assert.deepEqual(await client.callTool("shout", { text: "hello" }), { ok: true, content: "HELLO" });
    // A tool that fails is not a call that failed: the protocol's own error
    // shape comes back as a refusal the model can read.
    const failed = await client.callTool("explode", {});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /it went wrong/);
  } finally {
    client.close();
  }
});

test("its tools are ordinary tools: named, approved and refusable", async () => {
  const mcp = await connectMcpTools({ fixture: server() });
  try {
    // Named for the server, so two servers may offer the same tool name.
    assert.deepEqual(mcp.tools.map((tool) => tool.definition.name), ["fixture.shout", "fixture.explode"]);

    const requests = [];
    const result = await mcp.tools[0].invoke({ text: "hello" }, approve(requests));
    assert.deepEqual(result, { ok: true, content: "HELLO" });
    // Its own operation kind: a tool from somebody else's process is not a
    // file read, and the policy should be able to say so separately.
    assert.equal(requests[0].kind, "mcp");
    assert.equal(requests[0].toolName, "fixture.shout");

    const refused = await mcp.tools[0].invoke({ text: "hello" }, {
      agent: { name: "builder" },
      approve: async () => ({ kind: "reject", reason: "not this one" }),
    });
    assert.deepEqual(refused, { ok: false, error: "not this one" });
  } finally {
    mcp.close();
  }
});

test("the policy denies an MCP tool until a project says otherwise", async () => {
  // 'policy.operations.default' is deny, and nothing in a generated project
  // mentions 'mcp'. That is the right way round for foreign code.
  const shipped = new ApprovalPolicy({ allow: ["read"], requireHuman: ["write", "shell", "network"] }, {
    policy: new PolicyEngine({ operations: { default: "deny", rules: [{ id: "read-project", effect: "allow", kinds: ["read"], paths: ["**"] }] } }),
  });
  assert.equal((await shipped.evaluate({ kind: "mcp", toolName: "fixture.shout" }, { agent: "builder" })).kind, "reject");

  const permitted = new ApprovalPolicy({ allow: [], requireHuman: ["mcp"] }, {
    policy: new PolicyEngine({ operations: { default: "deny", rules: [{ id: "mcp-tools", effect: "human", kinds: ["mcp"] }] } }),
  });
  assert.equal((await permitted.evaluate({ kind: "mcp", toolName: "fixture.shout" }, { agent: "builder" })).kind, "human-required");
});

test("a server that will not start costs its tools, not the run", async () => {
  const problems = [];
  const mcp = await connectMcpTools({
    broken: { command: process.execPath, args: [fileURLToPath(new URL("./helpers/does-not-exist.mjs", import.meta.url))] },
    fixture: server(),
  }, { onError: (problem) => problems.push(problem) });
  try {
    assert.equal(problems.length, 1);
    assert.equal(problems[0].server, "broken");
    // The working one is still there.
    assert.deepEqual(mcp.tools.map((tool) => tool.definition.name), ["fixture.shout", "fixture.explode"]);
  } finally {
    mcp.close();
  }
});

test("only the tools a project asked for", async () => {
  const mcp = await connectMcpTools({ fixture: { ...server(), tools: ["shout"] } });
  try {
    assert.deepEqual(mcp.tools.map((tool) => tool.definition.name), ["fixture.shout"]);
  } finally {
    mcp.close();
  }
});

test("they reach an agent through the same list as the built-in tools", async () => {
  const mcp = await connectMcpTools({ fixture: server() });
  try {
    const tools = createWorkspaceTools({
      workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-mcp-")),
      extraTools: mcp.tools,
    });
    assert.equal(tools.definitions.some((definition) => definition.name === "fixture.shout"), true);
    const result = await tools.invoke("fixture.shout", { text: "via the workspace" }, approve());
    assert.equal(result.content, "VIA THE WORKSPACE");

    // And the per-agent allow-list governs them like anything else.
    const narrowed = createWorkspaceTools({
      workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-mcp-narrow-")),
      extraTools: mcp.tools,
      allowed: ["read_file"],
    });
    assert.equal(narrowed.definitions.some((definition) => definition.name === "fixture.shout"), false);
    const refused = await narrowed.invoke("fixture.shout", { text: "x" }, approve());
    assert.equal(refused.refused, "not-allowed");
  } finally {
    mcp.close();
  }
});

test("a server does not inherit this process's environment", async () => {
  // It is code the project did not write; handing it every variable this
  // process happens to hold is handing it the project's secrets.
  const seen = [];
  const client = createMcpClient({
    name: "watched",
    command: "node",
    args: [],
    env: { EXTRA: "1" },
    spawnImpl: (command, args, options) => {
      seen.push(options.env);
      return { stdout: { setEncoding() {}, on() {} }, stderr: { resume() {} }, stdin: { write() {}, end() {} }, once() {}, kill() {} };
    },
  });
  client.initialize().catch(() => {});
  assert.deepEqual(Object.keys(seen[0]).sort(), ["EXTRA", "HOME", "PATH"]);
  client.close();
});
