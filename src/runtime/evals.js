import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { git } from "../git/command.js";

// Measuring whether a run did the job, rather than whether the code ran.
//
// Every test in this repository asserts mechanics against a stub provider.
// None of them answers 'did the agent do what it was asked', how many attempts
// it took, or what it cost — and a plan whose phases all claim to make
// something better needs that to be a number.
//
// A case is a task, a starting workspace, and a list of mechanical checks. The
// checks are deliberately dull: a file exists and contains this, a command
// exits zero, nothing outside this directory was touched. A judgement like
// 'the code is good' is not something this can assert, and pretending
// otherwise would make the number worthless.
//
// What it measures depends on the provider the case runs against:
//   - 'scripted'  the harness, the tools, the policy and the receipts. Free,
//                 deterministic, and what 'npm run eval' does in CI.
//   - a real one  the agent. Costs money, is not deterministic, and is the
//                 thing to run after docs/first-real-run.md has been walked.
// The checks are the same either way, which is the point.

// What ETNPilot writes into a workspace by running at all: its own state, its
// index, its content lock. Counting those as 'the agent touched something it
// should not have' would fail every case for the harness's own bookkeeping —
// the same distinction 'removeIfClean' makes about a worktree.
const ETNPILOT_ARTIFACTS = Object.freeze([".etnpilot/", ".codegraph/"]);

export const CHECK_KINDS = Object.freeze(["fileExists", "fileContains", "fileAbsent", "commandSucceeds", "onlyTouched"]);

export async function listEvalCases(directory) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const cases = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, entry.name, "case.js");
    if (!await stat(file).then(() => true, () => false)) continue;
    const module = await import(`file://${file}`);
    cases.push(normalizeCase({ id: entry.name, directory: join(root, entry.name), ...module.default }));
  }
  return cases;
}

function normalizeCase(value) {
  if (!value.task || typeof value.task !== "string") throw new TypeError(`Eval '${value.id}' needs a task.`);
  if (!Array.isArray(value.expect) || value.expect.length === 0) {
    throw new TypeError(`Eval '${value.id}' needs at least one check; an eval that asserts nothing measures nothing.`);
  }
  for (const check of value.expect) {
    if (!CHECK_KINDS.includes(check.kind)) {
      throw new TypeError(`Eval '${value.id}': unknown check '${check.kind}'. Known: ${CHECK_KINDS.join(", ")}.`);
    }
  }
  return { files: {}, ...value };
}

// Runs the checks against the workspace a run left behind. Every one reports
// what it found, not only whether it passed: 'fileContains failed' is not
// something anybody can act on.
export async function judge(workspace, expect, { runCommand } = {}) {
  const results = [];
  for (const check of expect) {
    results.push({ ...check, ...await applyCheck(workspace, check, { runCommand }) });
  }
  return { ok: results.every((result) => result.ok), checks: results };
}

async function applyCheck(workspace, check, { runCommand }) {
  const target = check.path === undefined ? undefined : resolve(workspace, check.path);
  // A check that reaches outside the workspace is a broken case, not a
  // failing run.
  if (target !== undefined && !(target === resolve(workspace) || target.startsWith(resolve(workspace) + sep))) {
    throw new TypeError(`Eval check path '${check.path}' leaves the workspace.`);
  }
  if (check.kind === "fileExists" || check.kind === "fileAbsent") {
    const there = await stat(target).then((details) => details.isFile(), () => false);
    const wanted = check.kind === "fileExists";
    return { ok: there === wanted, found: there ? "present" : "absent" };
  }
  if (check.kind === "fileContains") {
    const content = await readFile(target, "utf8").catch(() => undefined);
    if (content === undefined) return { ok: false, found: "the file does not exist" };
    const matcher = check.pattern instanceof RegExp ? check.pattern : new RegExp(check.pattern);
    return matcher.test(content)
      ? { ok: true, found: "matched" }
      : { ok: false, found: `${content.length} characters, none matching` };
  }
  if (check.kind === "commandSucceeds") {
    const outcome = await (runCommand ?? defaultRunCommand)(check.command, workspace);
    return { ok: outcome.code === 0, found: `exit ${outcome.code}`, output: outcome.output };
  }
  // Nothing outside the listed paths changed. The most useful check there is:
  // an agent that fixes the test by editing the test has not fixed anything.
  const changed = await changedPaths(workspace);
  const allowed = [...(check.paths ?? []), ...ETNPILOT_ARTIFACTS];
  const stray = changed.filter((path) => !allowed.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
  return { ok: stray.length === 0, found: stray.length === 0 ? "nothing else changed" : `also changed: ${stray.join(", ")}` };
}

async function changedPaths(workspace) {
  // 'trim: false', and the path taken after the first space rather than at a
  // fixed width: the helper trims by default, so ' M path' arrives as 'M path'
  // and a slice(3) eats the first character of the path — which showed up as
  // 'etnpilot/etnpilot.yaml' escaping a filter written for '.etnpilot/'.
  const { stdout } = await git(["status", "--porcelain=v1", "-z"], { cwd: workspace, trim: false })
    .catch(() => ({ stdout: "" }));
  // Porcelain v1 is fixed width: two status characters, one space, the path.
  return stdout.split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

async function defaultRunCommand(command, cwd) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveOutcome) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk) => { output += String(chunk); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.once("error", (error) => resolveOutcome({ code: 127, output: error.message }));
    child.once("close", (code) => resolveOutcome({ code: code ?? 1, output: output.slice(-4000) }));
  });
}

// One line per case, and the numbers each phase of the plan claims to move.
export function summarizeEvals(results) {
  const passed = results.filter((result) => result.ok).length;
  const usage = results.reduce((total, result) => ({
    inputTokens: total.inputTokens + (result.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (result.usage?.outputTokens ?? 0),
    estimatedCost: total.estimatedCost + (result.usage?.estimatedCost ?? 0),
    toolCalls: total.toolCalls + (result.toolCalls ?? 0),
  }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0, toolCalls: 0 });
  return { cases: results.length, passed, failed: results.length - passed, usage };
}

export function formatEvalTable(results) {
  const rows = results.map((result) => [
    // ERROR: the run itself broke, so the agent was not measured. FAIL: it ran,
    // and the work did not satisfy the checks.
    result.ok ? "pass" : result.error ? "ERROR" : "FAIL",
    result.id,
    `${result.checks.filter((check) => check.ok).length}/${result.checks.length}`,
    String(result.toolCalls ?? 0),
    String(result.usage?.inputTokens ?? 0),
    String(result.usage?.outputTokens ?? 0),
    result.usage?.estimatedCost === undefined ? "—" : result.usage.estimatedCost.toFixed(4),
    `${Math.round((result.durationMs ?? 0) / 100) / 10}s`,
  ]);
  const head = ["", "CASE", "CHECKS", "TOOLS", "IN", "OUT", "COST", "TOOK"];
  const widths = head.map((_, column) => Math.max(...[head, ...rows].map((row) => row[column].length)));
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  const failures = results.flatMap((result) => result.checks
    .filter((check) => !check.ok)
    .map((check) => `  ${result.id}: ${check.kind}${check.path ? ` ${check.path}` : ""} — ${check.found}`));
  const errors = results.filter((result) => result.error).map((result) => `  ${result.id}: ${result.error}`);
  return [
    line(head),
    ...rows.map(line),
    ...(errors.length > 0 ? ["", "The run itself failed, so the agent was not measured:", ...errors] : []),
    ...(failures.length > 0 ? ["", "What failed:", ...failures] : []),
  ].join("\n");
}

// Sets up a throwaway project for one case and runs it. The project is a real
// one — git checkout, policy, approvals, receipts — because a measurement
// taken against a simplified harness measures the simplification.
export async function prepareEvalWorkspace(evalCase, root, { provider = "scripted" } = {}) {
  const { initializeProject } = await import("../config/init.js");
  const { setSetting } = await import("../config/settings.js");
  const { writeContentLock } = await import("../content/provenance.js");
  const { loadConfig } = await import("../config/load.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const YAML = (await import("yaml")).default;
  const { dirname } = await import("node:path");

  for (const [path, content] of Object.entries(evalCase.files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  await initializeProject(root);
  await git(["init", "--initial-branch=main", "."], { cwd: root });
  await git(["config", "user.email", "evals@etnpilot.local"], { cwd: root });
  await git(["config", "user.name", "ETNPilot evals"], { cwd: root });
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-m", "eval fixture"], { cwd: root });

  if (provider === "scripted") {
    // Into the committed file, not a local override: 'policy.**' is
    // stricter-only, so no local layer may add a provider the policy denies —
    // correctly, and the attempt is refused. This throwaway project is the
    // eval's own, so its committed default is the eval's to write.
    const file = join(root, ".etnpilot", "etnpilot.yaml");
    const document = YAML.parseDocument(await readFile(file, "utf8"));
    document.setIn(["providers", "scripted"], { type: "scripted", steps: evalCase.scripted ?? [] });
    document.setIn(["defaultProvider"], "scripted");
    const rules = document.getIn(["policy", "providers", "rules"])?.toJSON() ?? [];
    document.setIn(["policy", "providers", "rules"],
      rules.map((rule) => (rule.id === "configured-providers"
        ? { ...rule, providers: [...rule.providers, "scripted"] }
        : rule)));
    // One agent, one step: a workflow would measure the workflow.
    document.setIn(["workflow", "steps"], [{ id: "work", type: "agent", agent: "orchestrator" }]);
    await writeFile(file, String(document), "utf8");
  } else {
    await setSetting("defaultProvider", provider, { root, scope: "local" });
    await setSetting("workflow.steps", [{ id: "work", type: "agent", agent: "orchestrator" }], { root, scope: "local" });
  }
  // Not by widening 'approval.allow': it is stricter-only, and a local file
  // may not relax it — correctly, and the attempt is refused. What an eval
  // needs is an answerer, not a weaker policy, so the run gets a handler that
  // decides yes and is recorded as having done so. The policy still refuses
  // what it refuses, and a denied operation still fails the case.
  await writeContentLock(root, await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")));
  return root;
}

// Every request approved, and recorded as decided by the eval rather than by
// a person — a receipt that claimed a human had looked would be a lie told by
// a measurement.
export function evalApprovalHandler() {
  return async () => ({ kind: "approve-once", evidence: { decidedBy: "eval", decidedAt: new Date().toISOString() } });
}

// One case, end to end, in a directory of its own.
export async function runEvalCase(evalCase, { root, provider = "scripted", runProject: run } = {}) {
  const startedAt = Date.now();
  await prepareEvalWorkspace(evalCase, root, { provider });
  const runner = run ?? (await import("./project-runner.js")).runProject;
  let outcome;
  let failure;
  try {
    outcome = await runner({
      root,
      input: evalCase.task,
      agent: evalCase.agent,
      // In the checkout, so the checks read what the run left behind rather
      // than a worktree the run then threw away.
      worktree: false,
      approvalHandler: evalApprovalHandler(),
    });
  } catch (error) {
    failure = error.message;
  }
  // A run that ended without throwing can still have failed to run: a provider
  // with no key, a step that errored. That is not the agent doing the task
  // badly, and a table that says only "checks failed" cannot tell the two apart.
  if (failure === undefined && outcome?.summary?.status && outcome.summary.status !== "succeeded") {
    const reasons = Object.entries(outcome.summary.steps ?? {})
      .map(([id, step]) => (step.error || step.result?.error ? `${id}: ${step.error ?? step.result.error}` : undefined))
      .filter(Boolean);
    failure = reasons.length > 0 ? reasons.join("; ") : `the run ended '${outcome.summary.status}'`;
  }
  const verdict = await judge(root, evalCase.expect);
  const usage = await readUsage(root, outcome);
  return {
    id: evalCase.id,
    // A run that threw can still be judged: what matters is the workspace it
    // left, and 'it crashed' is itself a finding the checks will show.
    ok: verdict.ok && failure === undefined,
    ...(failure ? { error: failure } : {}),
    checks: verdict.checks,
    toolCalls: countToolCalls(outcome),
    usage,
    durationMs: Date.now() - startedAt,
  };
}

// 'summary.steps' is keyed by step id, not a list, and each step's provider
// result is where the tool calls are. A scripted provider records them as
// 'steps' rather than 'toolCalls', because it performed a script.
function countToolCalls(outcome) {
  return Object.values(outcome?.summary?.steps ?? {}).reduce((total, step) => {
    const result = step.result?.result ?? step.result ?? {};
    return total + (result.toolCalls?.length ?? result.steps?.length ?? 0);
  }, 0);
}

// What the run cost, from the receipt the run already wrote rather than from a
// second tally kept here.
async function readUsage(root, outcome) {
  const runId = outcome?.runId ?? outcome?.summary?.runId;
  if (!runId) return undefined;
  const { readReceipt, describeOutcome } = await import("./project-state.js");
  const receipt = await readReceipt(join(root, ".etnpilot", "state", "runs"), `${runId}.jsonl`).catch(() => undefined);
  return receipt ? describeOutcome(receipt).usage : undefined;
}

export { relative };
