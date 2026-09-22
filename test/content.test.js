import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { loadProject } from "../src/content/load-project.js";

test("project loader composes instructions, skills, prompts, and agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-content-"));
  const etn = join(root, ".etnpilot");
  await Promise.all([
    mkdir(join(etn, "instructions"), { recursive: true }),
    mkdir(join(etn, "prompts"), { recursive: true }),
    mkdir(join(etn, "skills", "review"), { recursive: true }),
    mkdir(join(etn, "agents"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(etn, "etnpilot.yaml"), "version: 1\n"),
    writeFile(join(etn, "instructions", "project.md"), "Keep diffs small."),
    writeFile(join(etn, "prompts", "reviewer.md"), "Review the change."),
    writeFile(join(etn, "skills", "review", "SKILL.md"), "# Review skill"),
    writeFile(join(etn, "agents", "reviewer.yaml"), [
      "name: reviewer",
      "provider: fake",
      "promptRef: reviewer",
      "skills: [review]",
      "subagents: []",
      "",
    ].join("\n")),
  ]);
  const harness = new Harness();
  const result = await loadProject(harness, root);
  assert.equal(result.config.version, 1);
  assert.equal(harness.instructions[0], "Keep diffs small.");
  assert.equal(harness.agents.get("reviewer").prompt, "Review the change.");
  assert.equal(harness.skills.get("review").name, "review");
});
