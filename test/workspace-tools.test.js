import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";

test("workspace tools stay inside the workspace and require approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tools-"));
  await writeFile(join(root, "existing.txt"), "hello\n");
  const tools = createWorkspaceTools({ workingDirectory: root });
  const requests = [];
  const approving = { approve: async (request) => (requests.push(request), { kind: "approve-once" }) };
  const rejecting = { approve: async () => ({ kind: "reject", reason: "Denied by policy." }) };

  assert.equal((await tools.invoke("read_file", { path: "existing.txt" }, approving)).content, "hello\n");
  assert.deepEqual(requests.at(-1), { kind: "read", fileName: "existing.txt", toolName: "read_file" });

  // Escaping the workspace is refused before any approval is requested.
  const escaped = await tools.invoke("read_file", { path: "../outside.txt" }, approving);
  assert.deepEqual(escaped, { ok: false, error: "Path escapes the workspace." });
  assert.equal(requests.length, 1);

  const written = await tools.invoke("write_file", { path: "nested/new.txt", content: "data" }, approving);
  assert.equal(written.ok, true);
  assert.equal(await readFile(join(root, "nested", "new.txt"), "utf8"), "data");
  assert.equal(requests.at(-1).kind, "write");

  // A rejected approval performs no effect and tells the model why.
  const refused = await tools.invoke("write_file", { path: "blocked.txt", content: "x" }, rejecting);
  assert.deepEqual(refused, { ok: false, error: "Denied by policy.", approved: false });
  await assert.rejects(() => readFile(join(root, "blocked.txt")));

  const listed = await tools.invoke("list_files", {}, approving);
  assert.equal(listed.ok, true);
  assert.ok(listed.entries.some((entry) => entry.name === "existing.txt" && entry.type === "file"));

  const ran = await tools.invoke("run_command", {
    command: [process.execPath, "-e", "process.stdout.write('ran')"],
  }, approving);
  assert.equal(ran.ok, true);
  assert.equal(ran.stdout, "ran");
  assert.equal(requests.at(-1).kind, "shell");
  assert.equal(requests.at(-1).fullCommandText.startsWith(process.execPath), true);

  // Shell metacharacters are arguments, never syntax.
  const literal = await tools.invoke("run_command", {
    command: [process.execPath, "-e", "process.stdout.write(process.argv[1] ?? '')", "a; rm -rf /"],
  }, approving);
  assert.equal(literal.ok, true);
  assert.equal(literal.stdout, "a; rm -rf /");

  assert.deepEqual(await tools.invoke("run_command", { command: "npm test" }, approving), {
    ok: false,
    error: "'command' must be a non-empty array of strings, for example [\"npm\",\"test\"].",
  });
});

test("the OpenAI-compatible provider runs an approved tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tool-loop-"));
  const bodies = [];
  const responses = [
    {
      choices: [{ message: { role: "assistant", tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "generated" }) },
      }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    {
      choices: [{ message: { role: "assistant", content: "Wrote out.txt." } }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
      model: "test-model",
    },
  ];
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://models.example.invalid/v1",
    apiKey: "key",
    model: "test-model",
    tools: true,
    workingDirectory: root,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(responses[bodies.length - 1]), { status: 200 });
    },
  });
  assert.deepEqual(provider.capabilities, ["chat", "tools"]);

  const approvals = [];
  const result = await provider.invoke({
    agent: { name: "worker", prompt: "Do the work." },
    input: "write a file",
    instructions: ["Follow the checklist."],
    skills: [{ content: "Skill text." }],
    approve: async (request) => (approvals.push(request.kind), { kind: "approve-once" }),
  });

  assert.equal(result.text, "Wrote out.txt.");
  assert.equal(await readFile(join(root, "out.txt"), "utf8"), "generated");
  assert.deepEqual(approvals, ["write"]);
  assert.deepEqual(result.toolCalls, [{ tool: "write_file", ok: true }]);
  assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
  // Instructions and skills reach the model, and tool results are fed back.
  assert.match(bodies[0].messages[0].content, /Do the work\.\n\nFollow the checklist\.\n\nSkill text\./);
  // Every tool the workspace offers, rather than a number that goes stale
  // the next time one is added — which is exactly what happened.
  assert.equal(bodies[0].tools.length, WORKSPACE_TOOL_DEFINITIONS.length);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
  assert.equal(JSON.parse(bodies[1].messages.at(-1).content).ok, true);
});

test("the tool loop is bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tool-bound-"));
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://models.example.invalid/v1",
    apiKey: "key",
    tools: true,
    workingDirectory: root,
    maxToolIterations: 2,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [{
        id: "call",
        function: { name: "list_files", arguments: "{}" },
      }] } }],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => provider.invoke({
      agent: { name: "worker", prompt: "p" },
      input: "loop",
      instructions: [],
      skills: [],
      approve: async () => ({ kind: "approve-once" }),
    }),
    /exceeded 2 tool iterations/,
  );
});

test("a command that failed says why, and an optional path may be left empty", async () => {
  // Reported from a real run: 'run_command did not succeed: no reason
  // recorded', twice. The reason was recorded — the exit code and the output
  // were in the result the model read — it just never reached the receipt.
  const root = await mkdtemp(join(tmpdir(), "etnpilot-tool-reasons-"));
  await writeFile(join(root, "README.md"), "x\n");
  const tools = createWorkspaceTools({ workingDirectory: root });
  const approving = { approve: async () => ({ kind: "approve-once" }) };

  const failed = await tools.invoke("run_command", {
    command: ["node", "-e", 'console.error("boom: missing config"); process.exit(2)'],
  }, approving);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 2);
  assert.match(failed.error, /'node' exited with code 2: boom: missing config/);

  // A command that fails silently still says which command and which code.
  const quiet = await tools.invoke("run_command", { command: ["node", "-e", "process.exit(3)"] }, approving);
  assert.match(quiet.error, /'node' exited with code 3, and said nothing\./);

  // And the same run reported "list_files did not succeed: 'path' must be a
  // non-empty string" — for a tool whose own schema marks 'path' optional.
  for (const args of [{ path: "" }, { path: "  " }, {}]) {
    const listed = await tools.invoke("list_files", args, approving);
    assert.equal(listed.ok, true, JSON.stringify(args));
    assert.equal(listed.path, ".");
    assert.deepEqual(listed.entries, [{ name: "README.md", type: "file" }]);
  }

  // Where the path is required, an empty one is still a mistake and says so.
  const read = await tools.invoke("read_file", { path: "" }, approving);
  assert.equal(read.ok, false);
  assert.match(read.error, /'path' must be a non-empty string/);

  // Arguments that could not be read became an empty object, so the model was
  // told 'content must be a string' when its JSON was the problem.
  const broken = await tools.invoke("write_file", "{not json", approving);
  assert.equal(broken.ok, false);
  assert.match(broken.error, /Tool arguments are not valid JSON/);
  const wrongShape = await tools.invoke("write_file", "[1,2]", approving);
  assert.match(wrongShape.error, /Tool arguments must be a JSON object\./);
});
