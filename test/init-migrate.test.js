import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { initializeProject } from "../src/config/init.js";
import { summarizeImport } from "../src/config/migrate.js";
import { loadPinnedProjectContent, writeContentLock } from "../src/content/provenance.js";
import { loadConfig } from "../src/config/load.js";

// 'etnpilot init' used to start every project from nothing, so what a team had
// already written for Claude Code, Codex, opencode or Copilot was left behind.

async function put(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function existingProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-migrate-"));
  await put(root, {
    "CLAUDE.md": "# Rules\n\nUse tabs.\n",
    "AGENTS.md": "# Rules\n\nUse tabs.\n", // same text: imported once
    "src/ui/CLAUDE.md": "UI code uses the design tokens.\n",
    "CLAUDE.local.md": "my private notes\n",
    ".github/copilot-instructions.md": "Prefer small commits.\n",
    ".cursor/rules/style.mdc": "---\ndescription: Style\nglobs: src/**/*.ts\n---\nNo default exports.\n",
    ".claude/agents/reviewer-x.md": "---\nname: Code Reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Glob, mcp__github__get_pr\nmodel: sonnet\n---\nYou review code.\nBe terse.\n",
    ".claude/agents/free.md": "---\nname: free\n---\nDo anything.\n",
    ".opencode/agent/docs.md": "---\ndescription: docs\ntools:\n  write: false\n  bash: false\n---\nWrite docs.\n",
    ".claude/skills/release/SKILL.md": "---\nname: release\ndescription: Cut a release\n---\nSteps.\n",
    ".claude/skills/release/scripts/check.sh": "echo ok\n",
    ".claude/skills/broken/notes.txt": "no skill file\n",
    ".claude/commands/deploy.md": "deploy it\n",
    ".claude/settings.json": "{}\n",
    "node_modules/pkg/CLAUDE.md": "not ours\n",
  });
  return root;
}

test("instructions, agents and skills of an existing project come along", async () => {
  const root = await existingProject();
  const { imported } = await initializeProject(root);

  const instructions = await readdir(join(root, ".etnpilot/instructions"), { recursive: true });
  assert.ok(instructions.includes("imported-claude.md"));
  assert.ok(!instructions.includes("imported-agents.md"), "identical text is imported once");
  assert.ok(instructions.includes(join("src", "ui", "imported-claude.md")), "a nested file keeps its scope");
  assert.ok(instructions.includes("imported-copilot.md"));
  assert.ok(instructions.includes("imported-cursor-style.md"));
  assert.ok(!instructions.some((name) => name.includes("local")), "personal files are not copied");
  assert.ok(!instructions.some((name) => name.includes("pkg")), "node_modules is not searched");
  const cursor = await readFile(join(root, ".etnpilot/instructions/imported-cursor-style.md"), "utf8");
  assert.match(cursor, /No default exports/);
  assert.match(cursor, /src\/\*\*\/\*\.ts/); // the glob it was limited to is kept in the header

  // An agent: name, prompt, mapped tools, nothing invented.
  const agent = YAML.parse(await readFile(join(root, ".etnpilot/agents/code-reviewer.yaml"), "utf8"));
  assert.equal(agent.promptRef, "code-reviewer");
  assert.deepEqual(agent.tools, ["read_file", "search_files", "list_files"]);
  assert.equal(agent.model, undefined);
  assert.match(await readFile(join(root, ".etnpilot/prompts/code-reviewer.md"), "utf8"), /Be terse/);
  const free = YAML.parse(await readFile(join(root, ".etnpilot/agents/free.yaml"), "utf8"));
  assert.equal(free.tools, undefined, "no restriction in the source, none invented");
  // opencode's map of switched-off tools: everything else stays on.
  const docs = YAML.parse(await readFile(join(root, ".etnpilot/agents/docs.yaml"), "utf8"));
  assert.ok(docs.tools.includes("read_file") && !docs.tools.includes("write_file") && !docs.tools.includes("run_command"));

  // A skill comes with its files; a folder without SKILL.md does not.
  assert.equal(await readFile(join(root, ".etnpilot/skills/release/scripts/check.sh"), "utf8"), "echo ok\n");
  assert.ok(!(await readdir(join(root, ".etnpilot/skills"))).includes("broken"));

  const text = summarizeImport(imported).join("\n");
  assert.match(text, /mcp__github__get_pr/); // the tool with no counterpart is named
  assert.match(text, /\.claude\/commands/);
  assert.match(text, /settings\.json/);
});

test("it never overwrites, and running it twice changes nothing", async () => {
  const root = await existingProject();
  await initializeProject(root);
  await writeFile(join(root, ".etnpilot/agents/free.yaml"), "name: free\npromptRef: mine\n");
  const again = await initializeProject(root);
  assert.equal(again.imported.agents.length, 0);
  assert.equal(again.imported.instructions.length, 0);
  assert.match(await readFile(join(root, ".etnpilot/agents/free.yaml"), "utf8"), /promptRef: mine/);
});

test("imported content is unreviewed until it is locked, and loads once it is", async () => {
  const root = await existingProject();
  await initializeProject(root);
  const config = await loadConfig(join(root, ".etnpilot/etnpilot.yaml"), {});
  await assert.rejects(() => loadPinnedProjectContent(root, config), /lock/i);
  await writeContentLock(root, config);
  const { snapshot } = await loadPinnedProjectContent(root, config);
  const names = snapshot.items.map((item) => `${item.type}:${item.name ?? item.path}`).join("\n");
  assert.match(names, /agent:/);
  assert.match(names, /skill:release/);
  assert.match(names, /instruction:/);
});

test("--no-import (importExisting: false) starts from nothing", async () => {
  const root = await existingProject();
  const result = await initializeProject(root, { importExisting: false });
  assert.equal(result.imported, undefined);
  assert.deepEqual(await readdir(join(root, ".etnpilot/instructions")), []);
});
