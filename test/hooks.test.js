import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../src/core/harness.js";
import { DEFAULT_MODES } from "../src/config/layers.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";

// P4.6: hooks that watch. They run after something happened and decide nothing.

const setup = async (hooks) => {
  const root = await mkdtemp(join(tmpdir(), "etn-hooks-"));
  const asked = [];
  const completed = [];
  const context = {
    agent: { name: "builder" },
    hooks,
    approve: async (request) => { asked.push(request); return { kind: "approve-once" }; },
    notifyToolCompleted: async (info) => { completed.push(info); },
  };
  return { root, asked, completed, context, tools: createWorkspaceTools({ workingDirectory: root }) };
};

const upcase = ["node", "-e", "const f=process.argv[1];require('fs').writeFileSync(f,require('fs').readFileSync(f,'utf8').toUpperCase())", "{path}"];

test("afterWrite runs on the file that was written, and its outcome is on the write", async () => {
  const { root, asked, context, tools } = await setup({ afterWrite: upcase });
  const result = await tools.invoke("write_file", { path: "a.txt", content: "quiet" }, context);
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "QUIET");
  assert.equal(result.afterWrite.ok, true);
  assert.equal(result.afterWrite.command.at(-1), "a.txt");
  // Asked for like any command the model made: the policy and a human see it.
  assert.deepEqual(asked.map((request) => request.kind), ["write", "shell"]);
});

test("a hook that fails, or is refused, never fails or blocks the write", async () => {
  const failing = await setup({ afterWrite: ["node", "-e", "process.exit(3)"] });
  const failed = await failing.tools.invoke("write_file", { path: "a.txt", content: "x" }, failing.context);
  assert.equal(failed.ok, true);
  assert.equal(failed.afterWrite.ok, false);

  const refused = await setup({ afterWrite: upcase });
  refused.context.approve = async (request) => (request.kind === "shell"
    ? { kind: "reject", reason: "no formatter today" }
    : { kind: "approve-once" });
  const result = await refused.tools.invoke("write_file", { path: "a.txt", content: "keep" }, refused.context);
  assert.equal(result.ok, true);
  assert.equal(result.afterWrite.ok, false);
  assert.equal(await readFile(join(refused.root, "a.txt"), "utf8"), "keep");
});

test("without a hook nothing extra runs", async () => {
  const { asked, context, tools } = await setup({});
  const result = await tools.invoke("write_file", { path: "a.txt", content: "x" }, context);
  assert.equal(result.afterWrite, undefined);
  assert.deepEqual(asked.map((request) => request.kind), ["write"]);
});

test("every tool call announces itself, and a subscriber that throws changes nothing", async () => {
  const { context, completed, tools } = await setup({});
  await tools.invoke("write_file", { path: "a.txt", content: "x" }, context);
  await tools.invoke("read_file", { path: "missing.txt" }, context);
  assert.deepEqual(completed.map((info) => [info.tool, info.ok]), [["write_file", true], ["read_file", false]]);
  context.notifyToolCompleted = async () => { throw new Error("subscriber broke"); };
  assert.equal((await tools.invoke("read_file", { path: "a.txt" }, context)).ok, true);
});

test("the harness turns it into an event a plugin can subscribe to", async () => {
  const harness = new Harness();
  const seen = [];
  harness.events.on("tool.completed", (event) => seen.push(event));
  harness.registerProvider({
    name: "p",
    async invoke(context) {
      await context.notifyToolCompleted({ tool: "read_file", ok: true, durationMs: 1 });
      return { text: "x" };
    },
  });
  harness.registerAgent({ name: "a", provider: "p", prompt: "x" });
  const receipt = await harness.run({ agent: "a", input: "go" });
  assert.equal(seen[0].tool, "read_file");
  assert.equal(seen[0].runId, receipt.runId);
  assert.equal(seen[0].agent, "a");
});

test("hooks and MCP servers are locked: a local file cannot add a command to run", () => {
  assert.equal(DEFAULT_MODES["hooks.**"], "locked");
  // A server is a process that starts with the run, before any tool call is
  // asked for, so it is decided by the committed file alone.
  assert.equal(DEFAULT_MODES["mcpServers.**"], "locked");
});
