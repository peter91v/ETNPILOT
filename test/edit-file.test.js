import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools, WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";
import { unifiedDiff } from "../src/providers/text-diff.js";
import { summarizeApprovalRequest } from "../src/core/approval-inbox.js";

// P1.1 and P1.2: the agent can change one line instead of rewriting the file,
// and the person deciding sees the change rather than its size.

const approveAll = (recorder) => ({
  approve: async (request) => {
    recorder?.push(request);
    return { kind: "approve-once" };
  },
});

test("edit_file replaces exactly what it was given and leaves the rest alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-edit-"));
  const before = [
    "// a comment the agent was not asked to touch",
    "export function total(items) {",
    "  return items.reduce((sum, item) => sum + item.price, 0);",
    "}",
    "",
  ].join("\n");
  await writeFile(join(root, "total.js"), before);

  const tools = createWorkspaceTools({ workingDirectory: root });
  const requests = [];
  const result = await tools.invoke("edit_file", {
    path: "total.js",
    old_string: "sum + item.price",
    new_string: "sum + item.price * item.quantity",
  }, approveAll(requests));

  assert.equal(result.ok, true);
  assert.equal(result.replacements, 1);
  const after = await readFile(join(root, "total.js"), "utf8");
  // Byte for byte, except the one piece: this is the whole point of the tool.
  assert.equal(after, before.replace("sum + item.price", "sum + item.price * item.quantity"));
  assert.match(after, /a comment the agent was not asked to touch/);
});

test("an ambiguous or absent match is refused, and says which", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-edit-ambiguous-"));
  await writeFile(join(root, "twice.js"), "const a = 1;\nconst b = 1;\n");
  const tools = createWorkspaceTools({ workingDirectory: root });

  const ambiguous = await tools.invoke("edit_file", {
    path: "twice.js", old_string: "= 1;", new_string: "= 2;",
  }, approveAll());
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /appears 2 times/);
  assert.match(ambiguous.error, /replace_all/);
  // Nothing was written, and nothing was asked of a person either.
  assert.equal(await readFile(join(root, "twice.js"), "utf8"), "const a = 1;\nconst b = 1;\n");

  const missing = await tools.invoke("edit_file", {
    path: "twice.js", old_string: "= 3;", new_string: "= 4;",
  }, approveAll());
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not appear/);
  assert.match(missing.error, /including indentation/);

  // replace_all is the way to say 'yes, all of them', and it reports how many.
  const all = await tools.invoke("edit_file", {
    path: "twice.js", old_string: "= 1;", new_string: "= 2;", replace_all: true,
  }, approveAll());
  assert.equal(all.ok, true);
  assert.equal(all.replacements, 2);
  assert.equal(await readFile(join(root, "twice.js"), "utf8"), "const a = 2;\nconst b = 2;\n");
});

test("nothing is written before a person has decided", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-edit-refused-"));
  await writeFile(join(root, "kept.txt"), "original\n");
  const tools = createWorkspaceTools({ workingDirectory: root });
  const refused = await tools.invoke("edit_file", {
    path: "kept.txt", old_string: "original", new_string: "replaced",
  }, { approve: async () => ({ kind: "reject", reason: "no" }) });
  assert.equal(refused.ok, false);
  assert.equal(await readFile(join(root, "kept.txt"), "utf8"), "original\n");
});

test("the approval carries the change, not its size", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-edit-approval-"));
  await writeFile(join(root, "auth.js"), "export function check(token) {\n  return verify(token);\n}\n");
  const tools = createWorkspaceTools({ workingDirectory: root });

  // The case this exists for: a one-line change that a byte count cannot
  // distinguish from a comment.
  const requests = [];
  await tools.invoke("edit_file", {
    path: "auth.js",
    old_string: "  return verify(token);",
    new_string: '  if (token === "letmein") return true;\n  return verify(token);',
  }, approveAll(requests));

  const [request] = requests;
  assert.equal(request.kind, "write");
  assert.equal(request.toolName, "edit_file");
  assert.match(request.diff, /\+  if \(token === "letmein"\) return true;/);
  assert.match(request.diff, /^@@ /m);

  // And it survives the trip into the inbox, where every surface reads it.
  const details = summarizeApprovalRequest(request);
  assert.match(details.diff, /letmein/);

  // A write to a file that exists shows the same, rather than a byte count.
  const writes = [];
  await tools.invoke("write_file", {
    path: "auth.js", content: "export function check() {\n  return true;\n}\n",
  }, approveAll(writes));
  assert.match(writes[0].diff, /-export function check\(token\)/);
  assert.match(writes[0].diff, /\+export function check\(\)/);
});

test("two writes to one path with different content are two different decisions", () => {
  // The fingerprint is what an 'approve this again' would key on, so the
  // content has to be part of it — otherwise approving one write approves a
  // different one to the same file.
  const base = { kind: "write", fileName: "a.js", toolName: "write_file" };
  const first = summarizeApprovalRequest({ ...base, diff: "@@\n+const a = 1;" });
  const second = summarizeApprovalRequest({ ...base, diff: "@@\n+const a = 2;" });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("the diff reads as a change, not as a deletion and an insertion", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  const after = ["one", "two", "THREE", "four", "five", "six", "seven"].join("\n");
  const diff = unifiedDiff(before, after, { path: "n.txt" });
  assert.equal(diff.added, 1);
  assert.equal(diff.deleted, 1);
  // Context around it, and only the changed line marked.
  assert.match(diff.text, /^ two$/m);
  assert.match(diff.text, /^-three$/m);
  assert.match(diff.text, /^\+THREE$/m);
  assert.equal(/^[-+]four$/m.test(diff.text), false);

  // A new file is an addition, against /dev/null, as diff has always said it.
  const created = unifiedDiff(undefined, "hello\n", { path: "new.txt" });
  assert.equal(created.created, true);
  assert.match(created.text, /--- \/dev\/null/);
  assert.match(created.text, /^\+hello$/m);

  // Identical content is not a diff at all.
  assert.equal(unifiedDiff("same\n", "same\n", { path: "x" }).unchanged, true);
});

test("a diff nobody could read says it was cut, rather than being cut silently", () => {
  const before = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");
  const after = Array.from({ length: 900 }, (_, index) => `changed ${index}`).join("\n");
  const diff = unifiedDiff(before, after, { path: "big.txt", maxDiffLines: 50 });
  assert.equal(diff.truncated, true);
  assert.match(diff.text, /more lines, not shown/);
  assert.equal(diff.text.split("\n").length < 60, true);

  // And two files too large to line up say that too, instead of pretending
  // the whole file changed for a reason nobody can see.
  const coarse = unifiedDiff(before, after, { path: "big.txt", maxComparedLines: 10 });
  assert.equal(coarse.coarse, true);
});

test("the tool list a provider offers includes it, with its rules in the description", () => {
  const edit = WORKSPACE_TOOL_DEFINITIONS.find((definition) => definition.name === "edit_file");
  assert.ok(edit, "edit_file is offered");
  assert.deepEqual(edit.parameters.required, ["path", "old_string", "new_string"]);
  // A model reads this and nothing else, so the rule it must follow is in it.
  assert.match(edit.description, /exactly once/);
  assert.match(edit.description, /Prefer this over write_file/);
  assert.match(edit.description, /human approval/);
});

test("the diff survives the inbox as lines, and nothing else does", () => {
  // Found by looking at the page rather than by a test: every detail goes
  // through the display sanitizer, which escapes control characters — so the
  // diff arrived as one line reading '--- x\\n+++ x\\n@@ ...' and the panel
  // rendered nothing anybody could read.
  const diff = unifiedDiff("a\nb\n", "a\nB\n", { path: "x.js" });
  const details = summarizeApprovalRequest({
    kind: "write",
    fileName: "x.js",
    // An escape sequence smuggled into the content it is meant to describe.
    diff: `${diff.text}\n\u001b[31mnot really a removal\u001b[0m`,
  });
  assert.equal(details.diff.includes("\n"), true, "a diff is only readable as lines");
  assert.equal(details.diff.includes("\\n"), false);
  // Everything that could fake a line in a terminal is still escaped.
  assert.equal(details.diff.includes("\u001b"), false);
  assert.match(details.diff, /\\u\{001b\}/);
  assert.match(details.diff, /^-b$/m);

  // And a field that is not a diff keeps its newlines escaped, because one
  // line is what those are.
  const command = summarizeApprovalRequest({ kind: "shell", fullCommandText: "npm test\nrm -rf /" });
  assert.match(command.command, /npm test\\nrm -rf \//);
});
