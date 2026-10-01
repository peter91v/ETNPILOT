import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

test("what would be published is the program and its documentation, and nothing else", async () => {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout);
  const files = pack.files.map((file) => file.path);
  for (const needed of ["bin/etnpilot.js", "src/index.js", "src/cli/commands.js", "src/ui/client/core.js", "src/ui/client/styles.css", "src/ui/client/markup.html", "package.json", "LICENSE"]) {
    assert.ok(files.includes(needed), `${needed} would not be in the package`);
  }
  for (const path of files) {
    assert.doesNotMatch(path, /^(test|test-ui|scripts|upstream|node_modules|\.etnpilot|\.github)\//, `${path} should not be published`);
  }
});

test("no production module imports the upstream project it was bootstrapped from", async () => {
  const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => (
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]
  )))).flat();
  for (const file of (await walk(join(root, "src"))).filter((path) => path.endsWith(".js"))) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*(upstream|agentwerk)[^"']*["']|import\(\s*["'][^"']*(upstream|agentwerk)/i, `${file} imports upstream code`);
  }
});
