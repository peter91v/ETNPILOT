import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { credentialHelperInstalled, installCredentialHelper, parseCredentialInput } from "../src/auth/git-credential.js";
import { saveKey } from "../src/auth/login.js";

const run = promisify(execFile);
const ok = { ok: true, status: 200, json: async () => ({ username: "peter" }) };

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "etn-gc-home-"));
  const repo = await mkdtemp(join(tmpdir(), "etn-gc-repo-"));
  await run("git", ["-C", repo, "init", "-q"]);
  const env = { ...process.env, ETNPILOT_HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  await saveKey("gitlab", "glpat-secret-token-123", { env, fetchImpl: async () => ok, host: "https://gitlab.example.com" });
  return { home, repo, env };
}

function fill(repo, env, url) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repo, "credential", "fill"], { env });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(`url=${url}\n\n`);
  });
}

test("the input of git is read as key=value lines", () => {
  assert.deepEqual(parseCredentialInput("protocol=https\nhost=gitlab.example.com\n\n"), { protocol: "https", host: "gitlab.example.com" });
});

test("git push gets the stored GitLab user and token through the installed helper", async () => {
  const { repo, env } = await setup();
  assert.equal(await credentialHelperInstalled(repo, "https://gitlab.example.com"), false);
  await installCredentialHelper(repo, "https://gitlab.example.com/some/path");
  assert.equal(await credentialHelperInstalled(repo, "https://gitlab.example.com"), true);
  // installing twice leaves one helper, not two
  await installCredentialHelper(repo, "https://gitlab.example.com");
  const { stdout } = await run("git", ["-C", repo, "config", "--local", "--get-all", "credential.https://gitlab.example.com.helper"]);
  assert.equal(stdout.split("\n").length - 1, 2);

  const answer = await fill(repo, env, "https://gitlab.example.com/group/project.git");
  assert.equal(answer.code, 0);
  assert.match(answer.out, /^username=peter$/m);
  assert.match(answer.out, /^password=glpat-secret-token-123$/m);
});

test("the helper stays silent for another host and for plain http", async () => {
  const { repo, env } = await setup();
  await installCredentialHelper(repo, "https://gitlab.example.com");
  await installCredentialHelper(repo, "https://other.example.org");
  const other = await fill(repo, env, "https://other.example.org/x.git");
  assert.notEqual(other.code, 0, "git has nobody left to ask");
  assert.doesNotMatch(other.out, /glpat/);
  await installCredentialHelper(repo, "http://gitlab.example.com");
  const plain = await fill(repo, env, "http://gitlab.example.com/x.git");
  assert.doesNotMatch(plain.out, /glpat/);
});
