import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { runCli } from "../src/cli/commands.js";
import { loadConfig } from "../src/config/load.js";
import { initializeProject } from "../src/config/init.js";
import { PRESETS, presetSettings } from "../src/providers/presets.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-presets-"));
  await initializeProject(root);
  return root;
}

async function quietly(operation) {
  const log = console.log;
  console.log = () => {};
  try { return await operation(); } finally { console.log = log; }
}

test("every preset is an https address (or this machine) and a usable name", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const url = new URL(preset.baseUrl);
    assert.ok(url.protocol === "https:" || url.hostname === "localhost", name);
    assert.doesNotThrow(() => presetSettings(name), name);
  }
  assert.throws(() => presetSettings("nope"), /Unknown preset/);
  assert.throws(() => presetSettings("gemini", "bad name"), /not a usable provider name/);
});

test("adding a keyed preset writes the provider, the secret mapping and the allow-list entry to the committed file", async () => {
  const root = await project();
  const before = await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8");
  await quietly(() => runCli(["provider", "add", "mistral"], { root }));
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  assert.equal(config.providers.mistral.baseUrl, "https://api.mistral.ai/v1");
  assert.equal(config.providers.mistral.apiKeySecret, "mistral-key");
  assert.deepEqual(config.secrets.values["mistral-key"], { provider: "env", key: "MISTRAL_API_KEY" });
  assert.ok(config.secrets.providers.env.allow.includes("MISTRAL_API_KEY"));
  // The rest of the file, comments included, is still there.
  const after = await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8");
  assert.ok(after.includes("# Empty on purpose"));
  assert.equal(YAML.parse(before).providers.openai.model, YAML.parse(after).providers.openai.model);
});

test("a preset without a key goes to the user's own settings, not the committed file", async () => {
  const root = await project();
  const before = await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8");
  await quietly(() => runCli(["provider", "add", "ollama"], { root, model: "qwen3" }));
  assert.equal(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"), before);
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  assert.equal(config.providers.ollama.model, "qwen3");
  assert.equal(config.providers.ollama.apiKeySecret, undefined);
});

test("an existing provider is not replaced unless asked", async () => {
  const root = await project();
  await quietly(() => runCli(["provider", "add", "groq"], { root }));
  await assert.rejects(runCli(["provider", "add", "groq"], { root }), /already has a provider 'groq'/);
  await quietly(() => runCli(["provider", "add", "groq"], { root, force: true }));
  await quietly(() => runCli(["provider", "add", "groq"], { root, name: "groq-fast" }));
  assert.ok((await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"))).providers["groq-fast"]);
});
