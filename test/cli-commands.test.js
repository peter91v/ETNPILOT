import assert from "node:assert/strict";
import test from "node:test";
import { CLI_OPTIONS, COMMANDS, runCli } from "../src/cli/commands.js";
import { readFile } from "node:fs/promises";

// Commands are entries in files under src/cli/commands/, each saying which
// command line it answers. Two entries answering the same line would make one
// of them unreachable; a line in the help that nothing answers would be a lie.

const usage = (await readFile(new URL("../src/cli/commands.js", import.meta.url), "utf8"));

test("every command line in the help is answered by exactly one entry", async () => {
  const text = usage.slice(usage.indexOf("const USAGE"), usage.indexOf("Exit codes:"));
  const lines = [...text.matchAll(/^ {2}etnpilot (\w+)(?: ([a-z]+))?/gm)].map((m) => ({ command: m[1], subcommand: m[2] }));
  assert.ok(lines.length > 40, `found only ${lines.length} usage lines`);
  for (const { command, subcommand } of lines) {
    const matches = COMMANDS.filter((entry) => entry.match({ command, subcommand }));
    // 'trust' is answered before the entries are tried.
    if (command === "trust") continue;
    assert.equal(matches.length, 1, `'${command} ${subcommand ?? ""}' is answered by ${matches.length} entries`);
  }
});

test("an unknown command is an error, and the options are not shadowed", async () => {
  await assert.rejects(runCli(["frobnicate"], { root: "." }), /Unknown command: frobnicate/);
  assert.equal(Object.keys(CLI_OPTIONS).length, new Set(Object.keys(CLI_OPTIONS)).size);
});

test("'etnpilot models' lists what a provider offers with the price the table knows", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5", owned_by: "openai", created: 1 }, { id: "mystery-chat", owned_by: "x", created: 2 }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "etnpilot-models-"));
  await mkdir(join(root, ".etnpilot"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), `version: 1\ndefaultProvider: p\nproviders:\n  p:\n    type: openai-compatible\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    apiKey: k\n    model: gpt-5\ncodegraph: { enabled: false }\nobservability: { enabled: false }\n`);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    assert.equal(await runCli(["models"], { root, provider: undefined, json: false }), 0);
  } finally {
    console.log = original;
    server.close();
  }
  const text = lines.join("\n");
  assert.match(text, /2 model\(s\) 'p' offers this account/);
  assert.match(text, /gpt-5\s+1\.25 \/ 10/);
  assert.match(text, /mystery-chat\s+no price known/);
});
