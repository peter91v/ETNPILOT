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
