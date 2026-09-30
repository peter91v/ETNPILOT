import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../src/core/harness.js";
import { loadProject } from "../src/content/load-project.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";
import { createResultEnvelope } from "../src/providers/tool-results.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etn-scoped-"));
  const etn = join(root, ".etnpilot");
  await mkdir(join(etn, "instructions", "src", "ui"), { recursive: true });
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(etn, "etnpilot.yaml"), "version: 1\ncontentProvenance:\n  mode: off\n");
  await writeFile(join(etn, "instructions", "project.md"), "Keep diffs small.");
  await writeFile(join(etn, "instructions", "src", "ui", "rules.md"), "Use the tokens, no colour literals.");
  await writeFile(join(root, "src", "ui", "a.js"), "a");
  await writeFile(join(root, "src", "ui", "b.js"), "b");
  await writeFile(join(root, "docs", "x.md"), "x");
  return root;
}

const approve = async () => ({ kind: "approve-once" });

test("a top-level instruction is for everyone, a nested one is held back", async () => {
  const root = await project();
  const harness = new Harness();
  await loadProject(harness, root, {});
  assert.deepEqual(harness.instructions, ["Keep diffs small."]);
  assert.equal(harness.scopedInstructions.length, 1);
  assert.equal(harness.scopedInstructions[0].scope, "src/ui");
});

test("a scoped instruction arrives with the first file under it, once, and never elsewhere", async () => {
  const root = await project();
  const harness = new Harness();
  await loadProject(harness, root, {});
  const tools = createWorkspaceTools({ workingDirectory: root, scopedInstructions: harness.scopedInstructions });
  const outside = await tools.invoke("read_file", { path: "docs/x.md" }, { approve });
  assert.equal(outside.projectInstructions, undefined);
  const first = await tools.invoke("read_file", { path: "src/ui/a.js" }, { approve });
  assert.equal(first.projectInstructions.length, 1);
  assert.match(first.projectInstructions[0].content, /no colour literals/);
  const second = await tools.invoke("read_file", { path: "src/ui/b.js" }, { approve });
  assert.equal(second.projectInstructions, undefined);
});

test("the instruction sits outside the tool-output envelope", () => {
  const envelope = createResultEnvelope("run");
  const text = envelope.render({
    ok: true,
    path: "src/ui/a.js",
    content: "x",
    projectInstructions: [{ scope: "src/ui", path: ".etnpilot/instructions/src/ui/rules.md", content: "Use the tokens." }],
  });
  const closing = text.lastIndexOf("</tool_output");
  assert.ok(text.indexOf("Use the tokens.") > closing);
  assert.doesNotMatch(text.slice(0, closing), /Use the tokens/);
});

test("a symlink inside instructions is refused like anywhere else in the pinned content", async () => {
  const root = await project();
  await symlink(join(root, "docs"), join(root, ".etnpilot", "instructions", "linked"));
  await assert.rejects(loadProject(new Harness(), root, {}), /Symbolic links/);
});
