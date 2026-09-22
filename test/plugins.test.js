import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { loadPlugins } from "../src/plugins/load-plugin.js";
import { definePlugin } from "../src/plugins/sdk.js";

test("plugin context rejects capabilities not declared in the manifest", async () => {
  const harness = new Harness();
  const plugin = definePlugin({
    apiVersion: 1,
    name: "limited",
    version: "1.0.0",
    capabilities: [],
    setup(context) {
      context.registerPrompt("unsafe", "not allowed");
    },
  });
  await assert.rejects(() => harness.use(plugin), /did not declare capability 'prompt\.register'/);
  assert.equal(harness.plugins.has("limited"), false);
});

test("plugin loader resolves dependencies before setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-plugins-"));
  await writeFile(join(root, "base.mjs"), `export default {
    apiVersion: 1, name: "base", version: "1.0.0",
    capabilities: ["instruction.add"],
    setup(context) { context.addInstruction("base"); }
  };\n`);
  await writeFile(join(root, "feature.mjs"), `export default {
    apiVersion: 1, name: "feature", version: "1.0.0", dependencies: ["base"],
    capabilities: ["instruction.add"],
    setup(context) { context.addInstruction("feature"); }
  };\n`);
  const harness = new Harness();
  await loadPlugins(["./feature.mjs", "./base.mjs"], harness, root);
  assert.deepEqual(harness.instructions, ["base", "feature"]);
});

test("plugin loader rejects missing and cyclic dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-plugin-errors-"));
  await writeFile(join(root, "missing.mjs"), `export default {
    apiVersion: 1, name: "missing-user", version: "1.0.0", dependencies: ["absent"],
    capabilities: [], setup() {}
  };\n`);
  await writeFile(join(root, "a.mjs"), `export default {
    apiVersion: 1, name: "a", version: "1.0.0", dependencies: ["b"], capabilities: [], setup() {}
  };\n`);
  await writeFile(join(root, "b.mjs"), `export default {
    apiVersion: 1, name: "b", version: "1.0.0", dependencies: ["a"], capabilities: [], setup() {}
  };\n`);
  await assert.rejects(
    () => loadPlugins(["./missing.mjs"], new Harness(), root),
    /Missing plugin dependency 'absent'/,
  );
  await assert.rejects(
    () => loadPlugins(["./a.mjs", "./b.mjs"], new Harness(), root),
    /Plugin dependency cycle/,
  );
});
