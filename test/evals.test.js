import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_KINDS, judge, listEvalCases, runEvalCase, formatEvalTable, summarizeEvals } from "../src/runtime/evals.js";
import { git } from "../src/git/command.js";
import { runCli } from "../src/cli/commands.js";

// P6.1: something that says whether a run did the job, so the phases of the
// plan can show a number instead of a claim.

test("the shipped cases pass end to end, through the real chain", async () => {
  const cases = await listEvalCases(new URL("./evals", import.meta.url).pathname);
  assert.equal(cases.length >= 2, true);
  for (const evalCase of cases) {
    const result = await runEvalCase(evalCase, { root: await mkdtemp(join(tmpdir(), "etnpilot-eval-")) });
    assert.equal(result.ok, true, `${evalCase.id}: ${JSON.stringify(result.checks.filter((check) => !check.ok))}`);
    // A real run: policy, approvals, receipts and the workspace tools, not a
    // simplified harness that would measure the simplification.
    assert.equal(result.toolCalls > 0, true, `${evalCase.id} performed no tool calls`);
    assert.equal(result.durationMs > 0, true);
  }
});

test("a case that asserts nothing is refused", async () => {
  // A directory each: a module is cached under its path, so rewriting one
  // file and importing again returns the first version.
  const broken = async (source) => {
    const root = await mkdtemp(join(tmpdir(), "etnpilot-eval-bad-"));
    await mkdir(join(root, "case"), { recursive: true });
    await writeFile(join(root, "case", "case.js"), source);
    return root;
  };

  await assert.rejects(
    async () => listEvalCases(await broken("export default { task: 'do it', expect: [] };\n")),
    /at least one check/,
  );
  await assert.rejects(
    async () => listEvalCases(await broken("export default { task: 'do it', expect: [{ kind: 'vibes' }] };\n")),
    /unknown check 'vibes'/i,
  );
  await assert.rejects(
    async () => listEvalCases(await broken("export default { expect: [{ kind: 'fileExists', path: 'x' }] };\n")),
    /needs a task/,
  );
});

test("the checks are mechanical, and say what they found", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "etnpilot-judge-"));
  await git(["init", "--initial-branch=main", "."], { cwd: workspace });
  await git(["config", "user.email", "t@t"], { cwd: workspace });
  await git(["config", "user.name", "t"], { cwd: workspace });
  await writeFile(join(workspace, "kept.txt"), "before\n");
  await git(["add", "-A"], { cwd: workspace });
  await git(["commit", "-m", "base"], { cwd: workspace });

  await writeFile(join(workspace, "made.txt"), "ready\n");
  await writeFile(join(workspace, "kept.txt"), "after\n");

  const verdict = await judge(workspace, [
    { kind: "fileExists", path: "made.txt" },
    { kind: "fileContains", path: "made.txt", pattern: "ready" },
    { kind: "fileAbsent", path: "never.txt" },
    { kind: "onlyTouched", paths: ["made.txt"] },
  ]);
  assert.equal(verdict.ok, false, "kept.txt was changed and was not allowed");
  assert.deepEqual(verdict.checks.map((check) => check.ok), [true, true, true, false]);
  // Not 'failed' but what it found, because nobody can act on 'failed'.
  assert.match(verdict.checks[3].found, /also changed: kept\.txt/);

  const missing = await judge(workspace, [{ kind: "fileContains", path: "never.txt", pattern: "x" }]);
  assert.match(missing.checks[0].found, /does not exist/);

  // A check that reaches outside the workspace is a broken case, not a
  // failing run, and is refused rather than answered.
  await assert.rejects(() => judge(workspace, [{ kind: "fileExists", path: "../../etc/passwd" }]), /leaves the workspace/);

  assert.deepEqual(CHECK_KINDS, ["fileExists", "fileContains", "fileAbsent", "commandSucceeds", "onlyTouched"]);
});

test("ETNPilot's own bookkeeping is not counted as the agent touching something", async () => {
  // Running at all writes '.etnpilot/state' and a content lock. Counting those
  // would fail every case for the harness's own paperwork.
  const workspace = await mkdtemp(join(tmpdir(), "etnpilot-judge-own-"));
  await git(["init", "--initial-branch=main", "."], { cwd: workspace });
  await git(["config", "user.email", "t@t"], { cwd: workspace });
  await git(["config", "user.name", "t"], { cwd: workspace });
  await writeFile(join(workspace, "a.txt"), "a\n");
  await git(["add", "-A"], { cwd: workspace });
  await git(["commit", "-m", "base"], { cwd: workspace });
  await mkdir(join(workspace, ".etnpilot", "state"), { recursive: true });
  await writeFile(join(workspace, ".etnpilot", "state", "runs.jsonl"), "{}\n");
  await writeFile(join(workspace, "wanted.txt"), "x\n");

  const verdict = await judge(workspace, [{ kind: "onlyTouched", paths: ["wanted.txt"] }]);
  assert.equal(verdict.ok, true, verdict.checks[0].found);
});

test("'etnpilot eval' runs them and its exit code is the verdict", async () => {
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    const code = await runCli(["eval", "write-a-file"], { root: process.cwd() });
    assert.equal(code, 0);
    assert.match(printed.at(-1), /pass\s+write-a-file/);
  } finally {
    console.log = original;
  }
  await assert.rejects(() => runCli(["eval", "no-such-case"], { root: process.cwd() }), /Unknown eval: no-such-case/);
});

test("the table names what failed, and the summary adds it up", () => {
  const table = formatEvalTable([
    { id: "a", ok: true, checks: [{ ok: true, kind: "fileExists" }], toolCalls: 2, durationMs: 1500, usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.02 } },
    { id: "b", ok: false, checks: [{ ok: false, kind: "fileContains", path: "x.txt", found: "3 characters, none matching" }], toolCalls: 0, durationMs: 400 },
  ]);
  assert.match(table, /pass {2}a/);
  assert.match(table, /FAIL {2}b/);
  assert.match(table, /What failed:/);
  assert.match(table, /b: fileContains x\.txt — 3 characters, none matching/);
  assert.match(table, /0\.0200/);

  const summary = summarizeEvals([{ ok: true, usage: { inputTokens: 10 } }, { ok: false }]);
  assert.deepEqual({ cases: summary.cases, passed: summary.passed, failed: summary.failed }, { cases: 2, passed: 1, failed: 1 });
  assert.equal(summary.usage.inputTokens, 10);
});

test("a run that could not start is an ERROR, not a failed measurement", async () => {
  const { formatEvalTable } = await import("../src/runtime/evals.js");
  const table = formatEvalTable([
    { id: "broke", ok: false, error: "Provider 'x' has no API key.", checks: [{ ok: false, kind: "fileExists", path: "a", found: "absent" }] },
    { id: "measured", ok: false, checks: [{ ok: false, kind: "fileExists", path: "a", found: "absent" }] },
  ]);
  assert.match(table, /ERROR\s+broke/);
  assert.match(table, /FAIL\s+measured/);
  assert.match(table, /agent was not measured:\n\s+broke: Provider 'x' has no API key\./);
});
