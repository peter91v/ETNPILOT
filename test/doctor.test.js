import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnose } from "../src/cli/commands.js";
import { initializeProject } from "../src/config/init.js";

// 'ready' has to mean a run could start. A report that checks node, git and
// sqlite and then says yes on a machine where the configured provider cannot
// run has told someone the opposite of what the next command will.

async function project(local) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-doctor-"));
  await initializeProject(root);
  if (local) await writeFile(join(root, ".etnpilot", "etnpilot.local.yaml"), local, "utf8");
  return root;
}

test("doctor reports the provider a run would reach, and whether it can run here", async () => {
  const root = await project("defaultProvider: openai\n");
  const withoutKey = { ...process.env };
  delete withoutKey.OPENAI_API_KEY;
  const before = process.env;
  try {
    process.env = withoutKey;
    const report = await diagnose(root);
    assert.equal(report.routing.agent, "orchestrator");
    assert.deepEqual(report.routing.route.map((entry) => entry.name), ["openai"]);
    assert.equal(report.routing.usable, null);
    // The variable to set, not just that something is missing.
    assert.match(report.routing.route[0].reason, /set OPENAI_API_KEY/);
    assert.equal(report.ready, false, "a run cannot start, so the report does not say ready");
    assert.equal(report.hints.some((hint) => /No routed provider can run here/.test(hint)), true);

    process.env = { ...withoutKey, OPENAI_API_KEY: "sk-test" };
    const keyed = await diagnose(root);
    assert.equal(keyed.routing.usable, "openai");
    assert.equal(keyed.routing.route[0].usable, true);
    assert.equal(keyed.ready, true);
    assert.deepEqual(keyed.routing.hints, []);
  } finally {
    process.env = before;
  }
});

test("a provider that cannot run here names the one that can", async () => {
  // The Android case: Copilot is routed, its SDK has no build for the
  // platform, and another configured provider is ready.
  const root = await project("defaultProvider: github-copilot\n");
  const before = process.env;
  try {
    process.env = { ...process.env, OPENAI_API_KEY: "sk-test" };
    const report = await diagnose(root);
    if (report.copilotSdk) return; // On a machine that has the SDK there is nothing to report.
    assert.equal(report.routing.usable, null);
    assert.match(report.routing.route[0].reason, /@github\/copilot-sdk/);
    assert.deepEqual(report.routing.alternatives, ["openai"]);
    assert.equal(
      report.routing.hints.some((hint) => /config set defaultProvider openai/.test(hint)),
      true,
      "the way out is in the report, not only in the docs",
    );
  } finally {
    process.env = before;
  }
});

test("an agent that names its own provider is the route, whatever the default says", async () => {
  const root = await project("defaultProvider: openai\n");
  await writeFile(
    join(root, ".etnpilot", "agents", "orchestrator.yaml"),
    "name: orchestrator\nprovider: anthropic\npromptRef: orchestrator\nskills: []\nrequires: [chat]\nsubagents: []\n",
    "utf8",
  );
  const before = process.env;
  try {
    process.env = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" };
    const report = await diagnose(root);
    assert.deepEqual(report.routing.route.map((entry) => entry.name), ["anthropic", "openai"]);
    assert.equal(report.routing.usable, "anthropic");
  } finally {
    process.env = before;
  }
});

test("a provider the policy denies is reported as denied, not as ready", async () => {
  // The trap this closes: the Copilot advice used to say 'configure an
  // openai-compatible provider instead'. A provider the project never listed
  // is denied by policy.providers, and 'policy.**' is stricter-only, so no
  // local file can allow it. The run said 'no provider can satisfy'; the
  // report now says which rule refused, and what is ready instead.
  const root = await project(
    "defaultProvider: openai-compatible\n"
    + "providers:\n"
    + "  openai-compatible:\n"
    + "    type: openai-compatible\n"
    + "    baseUrl: https://api.openai.com/v1\n"
    + "    model: gpt-5\n",
  );
  const before = process.env;
  try {
    process.env = { ...process.env, OPENAI_API_KEY: "sk-test" };
    const report = await diagnose(root);
    assert.equal(report.ready, false);
    assert.match(report.routing.route[0].reason, /denied by policy\.providers/);
    assert.deepEqual(report.routing.alternatives, ["openai"]);
  } finally {
    process.env = before;
  }
});

test("the Copilot advice does not send people to a provider the policy will deny", async () => {
  const { copilotSdkAdvice } = await import("../src/providers/copilot.js");
  const advice = copilotSdkAdvice("android", "arm64");
  assert.equal(/Configure an 'openai-compatible' provider/.test(advice), false);
  assert.match(advice, /another provider this project configures/);
  assert.match(advice, /etnpilot doctor/);
});
