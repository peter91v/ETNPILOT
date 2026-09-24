import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../src/git/command.js";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { SETTINGS, settingsEvidence } from "../src/config/layers.js";
import { describeSettings, diffSettings, setSetting, unsetSetting } from "../src/config/settings.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { createTelemetry } from "../src/observability/telemetry.js";
import { createSandbox } from "../src/runtime/sandbox.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-settings-"));
  await git(["init", "-b", "main"], { cwd: root });
  await initializeProject(root);
  // Every test gets its own global layer, so the machine running the suite
  // cannot change what the suite asserts.
  const env = { ...process.env, ETNPILOT_CONFIG_HOME: join(root, "config-home") };
  return { root, env, file: join(root, ".etnpilot", "etnpilot.yaml") };
}

async function writeLocal(root, yaml) {
  await writeFile(join(root, ".etnpilot", "etnpilot.local.yaml"), yaml, "utf8");
}

test("with no local file a project behaves exactly as it was committed", async () => {
  const { root, env, file } = await project();
  const config = await loadConfig(file, env);
  assert.equal(config.queue.workers, 1);
  assert.deepEqual(config[SETTINGS].layers.map((layer) => layer.source), ["project"]);
  assert.deepEqual(config[SETTINGS].overrides, []);
});

test("an open setting is the user's to change, locally and globally", async () => {
  const { root, env, file } = await project();
  await setSetting("queue.workers", 4, { root, env });
  assert.equal((await loadConfig(file, env)).queue.workers, 4);

  await setSetting("observability.environment", "staging", { root, env, scope: "global" });
  const config = await loadConfig(file, env);
  assert.equal(config.observability.environment, "staging");
  assert.deepEqual(config[SETTINGS].layers.map((layer) => layer.source), ["project", "user-global", "user-local"]);

  // The nearer layer wins.
  await setSetting("observability.environment", "laptop", { root, env });
  assert.equal((await loadConfig(file, env)).observability.environment, "laptop");

  await unsetSetting("observability.environment", { root, env });
  assert.equal((await loadConfig(file, env)).observability.environment, "staging");
});

test("local settings are never committed", async () => {
  const { root, env } = await project();
  await setSetting("queue.workers", 4, { root, env });
  const status = await git(["status", "--porcelain"], { cwd: root });
  assert.equal(status.stdout.includes("etnpilot.local.yaml"), false, status.stdout);
});

test("a locked setting can only change in the committed default", async () => {
  const { root, env, file } = await project();
  await assert.rejects(
    setSetting("receipts.signing.enabled", true, { root, env }),
    /locks this setting/,
  );
  await writeLocal(root, "receipts:\n  signing:\n    enabled: true\n");
  await assert.rejects(loadConfig(file, env), (error) => {
    assert.equal(error.code, "settings_refused");
    assert.equal(error.refusals[0].path, "receipts.signing.enabled");
    return true;
  });
});

test("a stricter-only setting may be narrowed but never widened", async () => {
  const { root, env, file } = await project();

  await assert.rejects(setSetting("approval.allow", ["read", "write"], { root, env }), /may only be removed/);
  await setSetting("approval.allow", [], { root, env });
  assert.deepEqual((await loadConfig(file, env)).approval.allow, []);

  await assert.rejects(setSetting("approval.requireHuman", ["write"], { root, env }), /may only be added/);
  await setSetting("approval.requireHuman", ["write", "shell", "network", "read"], { root, env });

  await assert.rejects(setSetting("policy.operations.default", "allow", { root, env }), /weaker than/);
  await setSetting("sandbox.enabled", true, { root, env });
  await assert.rejects(setSetting("checks.envAllow", ["PATH"], { root, env }), /may only be removed/);

  const config = await loadConfig(file, env);
  assert.equal(config.sandbox.enabled, true);
  assert.deepEqual(config.approval.requireHuman, ["write", "shell", "network", "read"]);
});

test("local policy rules are added, never replaced, and never weaker than the default", async () => {
  const { root, env, file } = await project();
  await setSetting("policy.operations.rules", [{ id: "no-shell-at-all", effect: "deny", kinds: ["shell"] }], { root, env });

  const config = await loadConfig(file, env);
  const ids = config.policy.operations.rules.map((rule) => rule.id);
  assert.equal(ids.includes("protect-credentials"), true, "the committed rules survive");
  assert.equal(ids.at(-1), "no-shell-at-all");

  const policy = new PolicyEngine(config.policy);
  assert.equal(policy.evaluateOperation({ kind: "shell", fullCommandText: "ls" }, { workspace: root }).kind, "reject");

  await assert.rejects(
    setSetting("policy.operations.rules", [{ id: "wide-open", effect: "allow", kinds: ["network"] }], { root, env }),
    /weaker than the section default/,
  );
  await assert.rejects(
    setSetting("policy.operations.rules", [{ id: "read-project", effect: "deny", kinds: ["read"] }], { root, env }),
    /already exists in the project default/,
  );
});

test("a setting with no mechanical narrowing rule is refused rather than guessed at", async () => {
  const { root, env } = await project();
  await assert.rejects(
    setSetting("policy.operations.rules.0.effect", "deny", { root, env }),
    /no mechanical rule for narrowing/,
  );
});

test("a refused local file names the setting, the file, and the reason", async () => {
  const { root, env, file } = await project();
  await writeLocal(root, "secrets:\n  providers:\n    env:\n      allow: [ANYTHING]\n");
  const error = await loadConfig(file, env).then(() => undefined, (caught) => caught);
  assert.equal(error.name, "SettingsError");
  assert.equal(error.refusals[0].source, "user-local");
  assert.match(error.message, /secrets\.providers\.env\.allow/);
});

test("settings are described and diffed with the layer each value came from", async () => {
  const { root, env } = await project();
  await setSetting("queue.workers", 4, { root, env });
  await setSetting("observability.environment", "staging", { root, env, scope: "global" });

  const described = await describeSettings({ root, env });
  const workers = described.entries.find((entry) => entry.path === "queue.workers");
  assert.deepEqual({ value: workers.value, source: workers.source, mode: workers.mode }, {
    value: 4,
    source: "user-local",
    mode: "open",
  });
  assert.equal(described.entries.some((entry) => entry.path.startsWith("settings.")), false, "modes are not settings");
  assert.equal(described.entries.find((entry) => entry.path === "approval.allow").mode, "stricter-only");

  const changes = await diffSettings({ root, env });
  assert.deepEqual(changes.map((change) => change.path), ["observability.environment", "queue.workers"]);
  assert.deepEqual(changes[0], {
    path: "observability.environment",
    from: "development",
    to: "staging",
    source: "user-global",
    mode: "open",
  });
});

test("a receipt records which layers were in effect and which settings they changed", async () => {
  const { root, env, file } = await project();
  await setSetting("queue.workers", 4, { root, env });
  const config = await loadConfig(file, env);
  const evidence = settingsEvidence(config);

  assert.deepEqual(evidence.overrides, ["queue.workers"]);
  assert.deepEqual(evidence.layers.map((layer) => layer.source), ["project", "user-local"]);
  for (const layer of evidence.layers) assert.match(layer.sha256, /^[0-9a-f]{64}$/);
  // The values themselves stay out of the receipt, and so do the file paths:
  // both carry local directory names.
  assert.deepEqual(Object.keys(evidence).sort(), ["layers", "overrides"]);
  assert.deepEqual(Object.keys(evidence.layers[0]).sort(), ["sha256", "source"]);
  assert.equal(JSON.stringify(evidence).includes(root), false);
});

test("the committed default declares the modes, and a local file cannot relax them", async () => {
  const { root, env, file } = await project();
  const committed = await readFile(file, "utf8");
  assert.match(committed, /^settings:$/m);
  await writeLocal(root, 'settings:\n  modes:\n    "receipts.signing.**": open\n');
  await assert.rejects(loadConfig(file, env), /settings\.modes/);
});

test("a setting that only accepts certain values offers them, and they are accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-choices-"));
  await initializeProject(root);
  const env = { ...process.env, ETNPILOT_CONFIG_HOME: join(root, "config-home") };
  const described = await describeSettings({ root, env });
  const byPath = Object.fromEntries(described.entries.map((entry) => [entry.path, entry]));

  assert.deepEqual(byPath["workspace.mode"].choices, { kind: "one", values: ["worktree", "in-place"] });
  assert.deepEqual(byPath["sandbox.enabled"].choices, { kind: "one", values: [true, false] });
  assert.deepEqual(byPath["approval.allow"].choices, { kind: "set", values: ["read", "write", "shell", "network"] });
  // The choice list is the project's own where the project decides it: which
  // provider to route to is whichever providers this project configures.
  assert.deepEqual(byPath["defaultProvider"].choices, { kind: "one", values: ["github-copilot"] });
  // A free-text setting is left alone rather than given a made-up list.
  assert.equal(byPath["git.committer.name"].choices, undefined);

  // Every offered value is one that can actually be written and loaded back.
  const writable = ["workspace.mode", "workspace.cleanup", "sandbox.network", "sandbox.runtime", "observability.failureMode"]
    .filter((path) => byPath[path].mode === "open");
  assert.equal(writable.length >= 4, true, "the open settings among these are the ones to try");
  for (const path of writable) {
    for (const value of byPath[path].choices.values) {
      const result = await setSetting(path, value, { root, env, scope: "local" });
      assert.equal(result.effective, value, `${path} = ${value}`);
      await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"), env);
    }
    await unsetSetting(path, { root, env, scope: "local" });
  }

  // And the offered values are the ones their own validator accepts, while a
  // value that is not offered is refused there. A list that suggests a value a
  // run would then reject is worse than no list at all.
  for (const value of byPath["observability.failureMode"].choices.values) {
    await createTelemetry({ root, config: { observability: { enabled: false, failureMode: value } } });
  }
  await assert.rejects(
    () => createTelemetry({ root, config: { observability: { enabled: false, failureMode: "sometimes" } } }),
    /failureMode must be ignore or fail/,
  );
  for (const value of byPath["sandbox.network"].choices.values) {
    createSandbox({ enabled: true, image: "node:24", network: value }, { workspace: root, probe: () => true });
  }
  assert.throws(
    () => createSandbox({ enabled: true, image: "node:24", network: "wifi" }, { workspace: root, probe: () => true }),
    /network/,
  );
});
