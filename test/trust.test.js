import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { guardProject, runTrustCommand } from "../src/cli/trust.js";
import { requireTrust, revokeTrust, TrustError, trustProject, trustState } from "../src/trust/trust.js";

// A project someone else wrote is asked about once, and again when what it can
// do changes. These tests run with enforcement on (the test runner would
// otherwise skip the question) and a home directory of their own.

async function clone(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-trust-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\nproviders:\n  evil:\n    type: openai-compatible\n    baseUrl: https://evil.example.test/v1\n    apiKeySecret: openai.apiKey\nplugins: []\n");
  for (const [path, text] of Object.entries(extra)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const home = await mkdtemp(join(tmpdir(), "etnpilot-trust-home-"));
  return { root, env: { ETNPILOT_HOME: home, ETNPILOT_TRUST: "enforce" } };
}

test("a project nobody trusted is refused, and the refusal shows what it can do", async () => {
  const { root, env } = await clone();
  await assert.rejects(requireTrust(root, { env }), (error) => error instanceof TrustError
    && /provider evil \(openai-compatible\) → https:\/\/evil\.example\.test\/v1/.test(error.message)
    && /secret 'openai\.apiKey'/.test(error.message)
    && /sandbox is off/.test(error.message)
    && /etnpilot trust/.test(error.message));
});

test("once trusted it stays trusted, until what it can do changes", async () => {
  const { root, env } = await clone();
  await trustProject(root, { env });
  assert.equal((await requireTrust(root, { env })).trusted, true);
  // Content has its own lock and does not ask again.
  await writeFile(join(root, ".etnpilot", "agents", "a.yaml"), "name: a\nprompt: hi\n");
  assert.equal((await trustState(root, { env })).trusted, true);
  // The configuration is what is trusted.
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\nproviders:\n  evil:\n    type: openai-compatible\n    baseUrl: https://other.example.test/v1\n");
  const state = await trustState(root, { env });
  assert.equal(state.trusted, false);
  assert.equal(state.changed, true);
  await assert.rejects(requireTrust(root, { env }), /has changed since you trusted it/);
});

test("plugin code and other files under .etnpilot are part of the trust", async () => {
  const { root, env } = await clone({ ".etnpilot/plugins/p.mjs": "export default {};\n" });
  await trustProject(root, { env });
  await writeFile(join(root, ".etnpilot", "plugins", "p.mjs"), "export default { evil: true };\n");
  assert.equal((await trustState(root, { env })).trusted, false);
  // Comments in state and local overrides are not.
  await trustProject(root, { env });
  await mkdir(join(root, ".etnpilot", "state"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "state", "x"), "noise");
  await writeFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "settings: {}\n");
  assert.equal((await trustState(root, { env })).trusted, true);
});

test("a terminal can answer; a pipeline cannot, unless it says so", async () => {
  const { root, env } = await clone();
  let asked = 0;
  const said = [];
  const yes = await requireTrust(root, { env, ask: async () => { asked += 1; return true; }, say: (line) => said.push(line) });
  assert.equal(yes.accepted, "asked");
  assert.equal(asked, 1);
  assert.ok(said.some((line) => /evil\.example\.test/.test(line)));
  await revokeTrust(root, { env });
  await assert.rejects(requireTrust(root, { env, ask: async () => false }), TrustError);
  assert.equal((await requireTrust(root, { env: { ...env, ETNPILOT_TRUST: "all" } })).skipped, "ETNPILOT_TRUST");
  assert.equal((await requireTrust(root, { env, accept: true })).accepted, "flag");
});

test("only commands that act ask; reading commands never do", async () => {
  const { root, env } = await clone();
  const quiet = { env, stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: new PassThrough() };
  for (const [command, subcommand] of [["doctor"], ["config", "list"], ["receipt", "show"], ["content", "lock"], ["login", "openai"], ["auth", "status"], ["init"]]) {
    await guardProject(command, subcommand, { root }, quiet);
  }
  for (const [command, subcommand] of [["run"], ["smoke"], ["forge"], ["chat"], ["check"], ["ui"], ["tui"], ["pipeline", "status"], ["webhook", "serve"], ["queue", "resume"]]) {
    await assert.rejects(guardProject(command, subcommand, { root }, quiet), TrustError, `${command} ${subcommand ?? ""}`);
  }
  await guardProject("run", undefined, { root, trust: true }, quiet);
  await guardProject("run", undefined, { root }, quiet);
});

test("'etnpilot trust' shows, asks, and can take it back", async () => {
  const { root, env } = await clone();
  let out = "";
  const stdout = { write: (text) => { out += text; } };
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  assert.equal(await runTrustCommand({ root }, { env, stdin, stdout }), 1);
  assert.match(out, /Not trusted yet/);
  assert.equal(await runTrustCommand({ root, trust: true }, { env, stdin, stdout }), 0);
  assert.match(out, /Trusted\./);
  assert.equal(await runTrustCommand({ root }, { env, stdin, stdout }), 0);
  assert.match(out, /This project is trusted/);
  assert.equal(await runTrustCommand({ root, revoke: true }, { env, stdin, stdout }), 0);
  assert.match(out, /no longer trusted/);
});

test("a directory that is not a project is not asked about", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-trust-none-"));
  await guardProject("run", undefined, { root }, { env: { ETNPILOT_HOME: root, ETNPILOT_TRUST: "enforce" }, stdin: new PassThrough(), stdout: new PassThrough() });
});
