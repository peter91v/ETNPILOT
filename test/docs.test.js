import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { listChecks } from "../src/runtime/project-checks.js";
import { USAGE } from "../src/cli/commands.js";

// A walkthrough that tells somebody to run a command that does not exist wastes
// their evening, and a document is the one part of a project nothing compiles.
// These check the parts that can be checked mechanically.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = USAGE.split("Exit codes:")[0];

test("every 'etnpilot ...' command the docs name is one the CLI has", async () => {
  const unknown = [];
  for (const file of ["docs/first-real-run.md", "docs/trying-it-out.md", "docs/roadmap-ui.md", "docs/first-15-minutes.md", "docs/login.md", "docs/index.md"]) {
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
  assert.match(text, /OpenAI chat and complete workflow were exercised on 2026-09-30/);
  assert.match(text, /\| A run completes end to end against a real provider \| .*succeeded.*OpenAI, 2026-09-30/);
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

test("every relative link in the README and the documentation index points at a file that exists", async () => {
  const { access } = await import("node:fs/promises");
  const missing = [];
  for (const file of ["README.md", "docs/index.md", "docs/first-15-minutes.md"]) {
    const text = await readFile(join(root, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)) {
      const path = join(root, dirname(file), target.split("#")[0]);
      if (!(await access(path).then(() => true, () => false))) missing.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
