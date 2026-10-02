import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInitWizard } from "../src/cli/wizard.js";
import { chooseDefaultProvider, gitlabState, parseProjectPath, providerChoices } from "../src/runtime/guided-setup.js";

const run = promisify(execFile);

async function workdir() {
  const home = await mkdtemp(join(tmpdir(), "etn-wiz-home-"));
  const root = await mkdtemp(join(tmpdir(), "etn-wiz-repo-"));
  await run("git", ["-C", root, "init", "-q"]);
  return { root, env: { ...process.env, ETNPILOT_HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } };
}

// Answers in order; a function answer sees the question (to check what was asked).
function scripted(answers, secrets = []) {
  const asked = [];
  return {
    asked,
    async ask(question, fallback = "") { asked.push(question); const next = answers.shift(); return next === undefined || next === "" ? fallback : next; },
    async confirm(question, fallback = true) { asked.push(question); const next = answers.shift(); return next === undefined ? fallback : next === true || /^y/i.test(String(next)); },
    async secret(question) { asked.push(question); return secrets.shift(); },
  };
}

const gitlabOk = async () => ({ ok: true, status: 200, json: async () => ({ username: "peter" }) });

test("a project path is read from a path, a web address or a clone address", () => {
  assert.equal(parseProjectPath("varga/etnpilot-smoke"), "varga/etnpilot-smoke");
  assert.equal(parseProjectPath("https://git.acme.test/a/b/c.git", "https://git.acme.test"), "a/b/c");
  assert.throws(() => parseProjectPath("https://elsewhere.org/a/b", "https://git.acme.test"), /elsewhere\.org/);
  assert.throws(() => parseProjectPath("justone"), /group\/project/);
});

test("the provider choices say which login is missing and a choice stays in the person's own settings", async () => {
  const { root, env } = await workdir();
  await runInitWizard(root, {
    prompter: scripted(["1", "3", false, false, false]), // template, provider #3, no login, no gitlab, no lock
    stdout: new PassThrough(), env,
  });
  const choices = await providerChoices({ root, env });
  assert.equal(choices.current, "openai");
  assert.equal(choices.options.find((option) => option.id === "openai").ready, false);
  await assert.rejects(chooseDefaultProvider("nope", { root, env }), /no provider 'nope'/);
  assert.doesNotMatch(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"), /defaultProvider: openai/);
});

test("the GitLab step stores the login, the project, the remote and the git helper in one go", async () => {
  const { root, env } = await workdir();
  const prompter = scripted(
    ["1", "2", false, true, "https://git.acme.test", "varga/etnpilot-smoke", "peter", false],
    ["glpat-wizard-token-1"],
  );
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => { text += chunk; });
  await runInitWizard(root, { prompter, stdout: out, env, fetchImpl: gitlabOk });
  assert.match(text, /Stored the GitLab token for peter/);
  assert.equal((await run("git", ["-C", root, "remote", "get-url", "gitlab"])).stdout.trim(), "https://git.acme.test/varga/etnpilot-smoke.git");
  const helper = await run("git", ["-C", root, "config", "--local", "--get-all", "credential.https://git.acme.test.helper"]);
  assert.match(helper.stdout, / credential/);
  const state = await gitlabState({ root, env });
  assert.deepEqual([state.baseUrl, state.project, state.remote, state.connected, state.helper], ["https://git.acme.test", "varga/etnpilot-smoke", "gitlab", true, true]);
  assert.equal(prompter.asked.some((question) => /token/i.test(question)), true);
});
