import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStyle, stripAnsi } from "../src/tui/ansi.js";
import { renderChecks, viewList } from "../src/tui/render.js";
import { createTuiApp } from "../src/tui/app.js";
import { initializeProject } from "../src/config/init.js";
import { knownCheck, listChecks, runProjectCheck } from "../src/runtime/project-checks.js";
import { openProjectState } from "../src/runtime/project-state.js";
import { runCli } from "../src/cli/commands.js";
import { git } from "../src/git/command.js";

const style = createStyle({ color: false });

test("the registry is the one list every surface reads", () => {
  const ids = listChecks().map((check) => check.id);
  assert.deepEqual(ids, ["doctor", "policy", "content", "deps", "secrets", "telemetry"]);
  for (const check of listChecks()) {
    // A row with no sentence to show is a row nobody can decide to run.
    assert.equal(typeof check.title, "string");
    assert.equal(check.about.length > 10, true, check.id);
  }
  assert.equal(knownCheck("doctor"), true);
  assert.equal(knownCheck("nope"), false);
  // The view exists, and it is reachable by the key the footer promises.
  assert.equal(viewList().indexOf("checks"), 6);
});

test("an unknown check is named, not silently skipped", async () => {
  await assert.rejects(() => runProjectCheck("nope", { root: process.cwd() }), /Unknown check 'nope'/);
});

test("each check reports what it found, against a real project", async () => {
  const root = await createProject();

  const secrets = await runProjectCheck("secrets", { root });
  assert.equal(secrets.id, "secrets");
  assert.equal(secrets.ok, true);
  assert.match(secrets.summary, /nothing found/);
  assert.equal(typeof secrets.ranAt, "string");
  assert.equal(Number.isInteger(secrets.durationMs), true);

  // A planted credential is found, and the finding names the file and line
  // without echoing the value itself. It has to be tracked: the scan reads
  // what git tracks, so an untracked file is not in its scope at all.
  await plantSecret(root);
  const leaked = await runProjectCheck("secrets", { root });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.findings.length > 0, true);
  assert.match(leaked.findings[0].text, /leak\.txt:1/);
  assert.equal(leaked.findings[0].label, "aws-access-key");
  // The value is never echoed in full: the scanner's preview is all that
  // travels, so a screenshot of this screen is not a leak of its own.
  assert.equal(leaked.findings.some((finding) => finding.text.includes("IOSFODNN7EXAMPLE")), false);

  // doctor answers whether a run could start here, and its hints are findings.
  const doctor = await runProjectCheck("doctor", { root });
  assert.equal(typeof doctor.ok, "boolean");
  assert.equal(doctor.detail.node, process.versions.node);

  // Every provider the project configures, against the policy in effect.
  const policy = await runProjectCheck("policy", { root });
  assert.deepEqual(policy.findings.map((finding) => finding.label), ["github-copilot", "anthropic", "openai"]);
  assert.equal(policy.findings.every((finding) => finding.tone === "ok"), true, "the shipped project allows its own providers");

  // 'deps' names the ecosystem it found; a list of records joined as text
  // reads as '[object Object]', which is what a first run of this showed.
  const deps = await runProjectCheck("deps", { root });
  assert.equal(deps.summary.includes("[object"), false);

  // Nothing has run in this project, so telemetry has no verdict to give —
  // which is not the same as passing.
  const telemetry = await runProjectCheck("telemetry", { root });
  assert.equal(telemetry.ok, undefined);
  assert.match(telemetry.summary, /nothing recorded yet/);

  // A fresh project has no content lock yet, and that is a finding about the
  // project rather than a broken check.
  const content = await runProjectCheck("content", { root });
  assert.equal(content.ok, false);
  assert.match(content.summary, /content-lock-missing/);
});

test("a check that cannot ask its question says so, rather than passing", async () => {
  // Outside a git checkout the secret scan has no tracked files to read.
  // 'nothing found' there would be a claim about a tree it never opened.
  const copied = await mkdtemp(join(tmpdir(), "etnpilot-checks-nogit-"));
  await initializeProject(copied);
  const secrets = await runProjectCheck("secrets", { root: copied });
  assert.equal(secrets.ok, undefined);
  assert.match(secrets.summary, /not a git checkout/);
  assert.match(secrets.findings[0].text, /files git tracks/);

  // Provenance switched off is the same shape of answer: no verdict, and the
  // reason on screen.
  const off = await runProjectCheck("content", { root: copied, config: { content: { provenance: { mode: "off" } } } });
  assert.equal(off.ok, undefined);
  assert.match(off.summary, /provenance is off/);
});

test("the checks view runs one on enter and all on A, and never on its own", async () => {
  const root = await createProject();
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  const state = await openProjectState({ root });
  const ran = [];
  // The registry is what the view lists; the run path is watched, because the
  // rule here is that a poll must never start one.
  const watched = { ...state, runCheck: (id) => (ran.push(id), state.runCheck(id)) };
  const app = createTuiApp({ state: watched, output: fakeOutput(), input: new EventEmitter() });
  try {
    await app.refresh();
    await app.handle("7");
    assert.equal(app.view, "checks");
    let frame = stripAnsi(app.frame().join("\n"));
    assert.match(frame, /none run yet/);
    assert.match(frame, /not run/);
    // A poll does not run anything.
    await app.refresh();
    assert.deepEqual(ran, []);

    // The cursor's row is the one that runs.
    await app.handle("j");
    await app.handle("j");
    await app.handle("j");
    await app.handle("j");
    await app.handle("\r");
    assert.deepEqual(ran, ["secrets"]);
    frame = stripAnsi(app.frame().join("\n"));
    assert.match(frame, /scan secrets/);
    assert.match(frame, /nothing found/);
    assert.equal(app.checkResults.secrets.ok, true);

    await app.handle("A");
    assert.deepEqual(new Set(ran), new Set(["doctor", "policy", "content", "deps", "secrets", "telemetry"]));
    frame = stripAnsi(app.frame().join("\n"));
    assert.match(frame, /6 run/);
  } finally {
    app.stop();
    state.close();
  }
});

test("the view says which state each check is in, and never confuses them", () => {
  const checks = listChecks();
  const bare = stripAnsi(renderChecks({}, { style, width: 100, height: 20, cursor: 0, checks }).join("\n"));
  assert.match(bare, /none run yet/);
  assert.match(bare, /nothing to report/);
  // Its own description stands in for a result it does not have, and the
  // panel says what pressing enter would do rather than looking empty.
  assert.match(bare, /Whether a run could start here/);
  assert.match(bare, /enter runs 'doctor'/);

  const results = {
    doctor: { id: "doctor", title: "doctor", ok: false, summary: "not ready", ranAt: new Date().toISOString(), findings: [{ text: "Set OPENAI_API_KEY." }] },
  };
  const withResult = stripAnsi(renderChecks({}, { style, width: 100, height: 20, cursor: 0, checks, results }).join("\n"));
  assert.match(withResult, /findings/);
  assert.match(withResult, /doctor: not ready/);
  assert.match(withResult, /Set OPENAI_API_KEY/);
  assert.equal(/none run yet/.test(withResult), false);

  // 'running' is its own state: a check in flight is not a check that passed,
  // and not one that was never asked.
  const running = stripAnsi(renderChecks({}, { style, width: 100, height: 20, cursor: 0, checks, results, running: new Set(["secrets"]) }).join("\n"));
  assert.match(running, /running…/);

  // A check with no verdict reads as that, not as ok.
  const neither = stripAnsi(renderChecks({}, {
    style, width: 100, height: 20, cursor: 5, checks,
    results: { telemetry: { id: "telemetry", title: "telemetry summary", ok: undefined, summary: "nothing recorded yet", ranAt: new Date().toISOString(), findings: [] } },
  }).join("\n"));
  assert.match(neither, /no verdict/);
});

test("'etnpilot check' runs the same registry from the terminal", async () => {
  const root = await createProject();
  const printed = [];
  const original = console.log;
  console.log = (text) => printed.push(String(text));
  try {
    assert.equal(await runCli(["check", "secrets"], { root }), 0);
    const one = JSON.parse(printed.at(-1));
    assert.equal(one.id, "secrets");

    // No name runs them all, under one key, so a script can read the lot.
    assert.equal(await runCli(["check"], { root }) >= 0, true);
    const all = JSON.parse(printed.at(-1));
    assert.deepEqual(all.checks.map((check) => check.id), listChecks().map((check) => check.id));

    // A check with no verdict does not decide the exit code; a failing one does.
    await plantSecret(root);
    assert.equal(await runCli(["check", "secrets"], { root }), 1);
  } finally {
    console.log = original;
  }
  await assert.rejects(() => runCli(["check", "nope"], { root }), /Unknown check: nope/);
});

// The secret scan reads what git tracks, so a project to check has to be a
// checkout — the same thing a real one is.
async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-checks-"));
  await initializeProject(root);
  await git(["init", "--initial-branch=main", "."], { cwd: root });
  await git(["config", "user.email", "tests@etnpilot.local"], { cwd: root });
  await git(["config", "user.name", "ETNPilot tests"], { cwd: root });
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function plantSecret(root) {
  // A key id in the shape the scanner's own AWS rule matches. It is AWS's own
  // documentation example, and the marker keeps this repository's own scan
  // from reporting the fixture — which is what that marker is for.
  await writeFile(join(root, "leak.txt"), 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n'); // etnpilot:allow-secret
  await git(["add", "leak.txt"], { cwd: root });
}

function fakeOutput() {
  const output = new EventEmitter();
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  output.write = () => {};
  return output;
}
