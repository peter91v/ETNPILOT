import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { listChecks } from "../src/runtime/project-checks.js";

// A walkthrough that tells somebody to run a command that does not exist wastes
// their evening, and a document is the one part of a project nothing compiles.
// These check the parts that can be checked mechanically.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = (await readFile(join(root, "src/cli/commands.js"), "utf8"))
  .split("Exit codes:")[0];

test("every 'etnpilot ...' command the docs name is one the CLI has", async () => {
  const unknown = [];
  for (const file of ["docs/first-real-run.md", "docs/trying-it-out.md", "docs/roadmap-ui.md"]) {
    const text = await readFile(join(root, file), "utf8");
    for (const [, command] of text.matchAll(/\betnpilot ([a-z]+(?: [a-z]+)?)/g)) {
      const [first, second] = command.split(" ");
      // A subcommand only counts as one where the usage pairs them; otherwise
      // the first word is the command and the rest is prose.
      const line = usage.includes(`etnpilot ${first} ${second}`) ? `etnpilot ${first} ${second}` : `etnpilot ${first}`;
      if (!usage.includes(line)) unknown.push(`${file}: ${line}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], []);
});

test("the first-real-run walkthrough says what is proven and what is not", async () => {
  const text = await readFile(join(root, "docs/first-real-run.md"), "utf8");
  // The point of the document is the distinction, so it is stated outright.
  assert.match(text, /It is not a claim that this has been\s*done/);
  assert.match(text, /\| A run completes end to end against a real provider \| \*\*nothing\*\* \| — \|/);
  assert.match(text, /\| A real GitLab instance accepts what a run publishes \| \*\*nothing\*\* \| — \|/);
  // And every failure it records names a date and a platform.
  const entries = [...text.matchAll(/^### (\d{4}-\d{2}-\d{2}) — (.+)$/gm)];
  assert.equal(entries.length >= 2, true);
  for (const [, date, where] of entries) {
    assert.equal(Number.isNaN(Date.parse(date)), false, date);
    assert.equal(where.length > 5, true, where);
  }
});

test("the checks the docs name are the checks that exist", async () => {
  const ids = listChecks().map((check) => check.id);
  const text = await readFile(join(root, "docs/first-real-run.md"), "utf8");
  for (const [, named] of text.matchAll(/etnpilot check ([a-z]+)/g)) {
    assert.equal(ids.includes(named), true, "'" + named + "' is not a check");
  }
});
