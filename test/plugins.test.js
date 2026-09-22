import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { loadPlugins } from "../src/plugins/load-plugin.js";
import { normalizePluginLimits } from "../src/plugins/protocol.js";

test("plugin isolation configuration rejects typos and unsafe ranges", () => {
  assert.throws(() => normalizePluginLimits({ callTimoutMs: 10 }), /Unsupported plugin isolation limit/);
  assert.throws(() => normalizePluginLimits({ memoryMb: 8 }), /memoryMb/);
  assert.equal(normalizePluginLimits({ memoryMb: 96 }).memoryMb, 96);
});

test("plugin workers reject capabilities not declared in the manifest", async () => {
  const root = await pluginDirectory("undeclared", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "limited", version: "1.0.0", capabilities: [],
      setup(context) { context.registerPrompt("unsafe", "not allowed"); }
    };\n`,
  });
  const harness = new Harness();
  await assert.rejects(
    () => loadPlugins(["./plugin.mjs"], harness, root),
    /did not declare capability 'prompt\.register'/,
  );
  assert.equal(harness.plugins.has("limited"), false);
  await harness.close();
});

test("plugin loader resolves dependencies before applying setup actions", async () => {
  const root = await pluginDirectory("dependencies", {
    "base.mjs": `export default {
      apiVersion: 1, name: "base", version: "1.0.0", capabilities: ["instruction.add"],
      setup(context) { context.addInstruction("base"); }
    };\n`,
    "feature.mjs": `export default {
      apiVersion: 1, name: "feature", version: "1.0.0", dependencies: ["base"],
      capabilities: ["instruction.add"], setup(context) { context.addInstruction("feature"); }
    };\n`,
  });
  const harness = new Harness();
  await loadPlugins(["./feature.mjs", "./base.mjs"], harness, root);
  assert.deepEqual(harness.instructions, ["base", "feature"]);
  await harness.close();
});

test("plugin loader rejects missing and cyclic dependencies and cleans up workers", async () => {
  const root = await pluginDirectory("dependency-errors", {
    "missing.mjs": `export default {
      apiVersion: 1, name: "missing-user", version: "1.0.0", dependencies: ["absent"],
      capabilities: [], setup() {}
    };\n`,
    "a.mjs": `export default {
      apiVersion: 1, name: "a", version: "1.0.0", dependencies: ["b"], capabilities: [], setup() {}
    };\n`,
    "b.mjs": `export default {
      apiVersion: 1, name: "b", version: "1.0.0", dependencies: ["a"], capabilities: [], setup() {}
    };\n`,
  });
  await assert.rejects(
    () => loadPlugins(["./missing.mjs"], new Harness(), root),
    /Missing plugin dependency 'absent'/,
  );
  await assert.rejects(
    () => loadPlugins(["./a.mjs", "./b.mjs"], new Harness(), root),
    /Plugin dependency cycle/,
  );
});

test("isolated providers use bounded bidirectional RPC", async () => {
  const root = await pluginDirectory("provider-rpc", {
    "plugin.mjs": `import { definePlugin } from "etnpilot";
      export default definePlugin({
        apiVersion: 1, name: "remote-provider", version: "1.0.0",
        capabilities: ["provider.register"],
        setup(context) {
          context.registerProvider({ name: "remote", capabilities: ["chat"], async invoke(run) {
            const approval = await run.approve({ kind: "read", fileName: "README.md" });
            const child = await run.spawn("reviewer", "inspect");
            return { input: run.input, approval, child };
          }});
        }
      });\n`,
  });
  const harness = new Harness();
  await loadPlugins(["./plugin.mjs"], harness, root);
  const calls = [];
  const result = await harness.providers.get("remote").invoke({
    runId: "run-1",
    agent: { name: "builder", prompt: "Build", provider: "remote" },
    input: "hello",
    metadata: {},
    instructions: [],
    skills: [],
    approve: async (request) => { calls.push(request); return { kind: "approve-once" }; },
    spawn: async (agent, input) => ({ agent, input }),
  });
  assert.deepEqual(result, {
    input: "hello",
    approval: { kind: "approve-once" },
    child: { agent: "reviewer", input: "inspect" },
  });
  assert.equal(calls.length, 1);
  await harness.close();
  assert.equal(harness.providers.has("remote"), false);
  assert.equal(harness.plugins.has("remote-provider"), false);
});

test("plugin workers hide the host environment and deny filesystem, process, and network access", async () => {
  const root = await pluginDirectory("permissions", {
    "environment.mjs": `export default {
      apiVersion: 1, name: "environment", version: "1.0.0", capabilities: ["instruction.add"],
      setup(context) { context.addInstruction(String(process.env.ETNPILOT_TEST_SECRET)); }
    };\n`,
    "filesystem.mjs": `import { readFile } from "node:fs/promises";
      export default { apiVersion: 1, name: "filesystem", version: "1.0.0", capabilities: [], setup() {} };\n`,
    "process.mjs": `import { execFile } from "node:child_process";
      export default { apiVersion: 1, name: "process", version: "1.0.0", capabilities: [], setup() { execFile("true"); } };\n`,
    "network.mjs": `export default {
      apiVersion: 1, name: "network", version: "1.0.0", capabilities: [],
      async setup() { await fetch("http://127.0.0.1:1"); }
    };\n`,
  });
  const harness = new Harness();
  process.env.ETNPILOT_TEST_SECRET = "must-not-cross-boundary";
  await loadPlugins(["./environment.mjs"], harness, root);
  assert.deepEqual(harness.instructions, ["undefined"]);
  await harness.close();
  await assert.rejects(() => loadPlugins(["./filesystem.mjs"], new Harness(), root), /not permitted|restricted/);
  await assert.rejects(() => loadPlugins(["./process.mjs"], new Harness(), root), /not permitted|restricted/);
  await assert.rejects(() => loadPlugins(["./network.mjs"], new Harness(), root), /network access is not permitted/i);
  delete process.env.ETNPILOT_TEST_SECRET;
});

test("plugin workers reject CommonJS entry points that could bypass import controls", async () => {
  const root = await pluginDirectory("commonjs", {
    "plugin.cjs": `const net = require("node:net"); module.exports = {
      apiVersion: 1, name: "commonjs", version: "1.0.0", capabilities: [], setup() { return net; }
    };\n`,
  });
  await assert.rejects(
    () => loadPlugins(["./plugin.cjs"], new Harness(), root),
    (error) => error.code === "plugin_format_unsupported",
  );
});

test("plugin setup is terminated at the runtime limit", async () => {
  const root = await pluginDirectory("timeout", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "hang", version: "1.0.0", capabilities: [],
      setup() { for (;;) {} }
    };\n`,
  });
  await assert.rejects(
    () => loadPlugins([{ path: "./plugin.mjs", limits: { setupTimeoutMs: 150 } }], new Harness(), root),
    (error) => error.code === "plugin_timeout",
  );
});

test("plugin setup honors external cancellation", async () => {
  const root = await pluginDirectory("abort", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "abort", version: "1.0.0", capabilities: [],
      async setup() { await new Promise(() => {}); }
    };\n`,
  });
  const controller = new AbortController();
  const loading = loadPlugins(["./plugin.mjs"], new Harness(), root, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
  await assert.rejects(loading, (error) => error.code === "plugin_aborted" && error.name === "AbortError");
});

test("plugin stdout and stderr are bounded", async () => {
  const root = await pluginDirectory("output", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "noisy", version: "1.0.0", capabilities: [],
      async setup() { console.log("x".repeat(20_000)); await new Promise((resolve) => setTimeout(resolve, 500)); }
    };\n`,
  });
  await assert.rejects(
    () => loadPlugins([{ path: "./plugin.mjs", limits: { maxOutputBytes: 1_024 } }], new Harness(), root),
    (error) => error.code === "plugin_output_limit",
  );
});

test("plugin heap and resident memory are bounded", async () => {
  const root = await pluginDirectory("memory", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "memory", version: "1.0.0", capabilities: [],
      async setup() {
        globalThis.kept = Buffer.alloc(96 * 1024 * 1024, 1);
        await new Promise(() => {});
      }
    };\n`,
  });
  await assert.rejects(
    () => loadPlugins([{ path: "./plugin.mjs", limits: {
      memoryMb: 64, memoryPollIntervalMs: 25, setupTimeoutMs: 5_000,
    } }], new Harness(), root),
    (error) => ["plugin_memory_limit", "plugin_process_exit"].includes(error.code),
  );
});

test("oversized RPC results terminate the plugin without affecting the host", async () => {
  const root = await pluginDirectory("rpc-output", {
    "plugin.mjs": `export default {
      apiVersion: 1, name: "oversized", version: "1.0.0", capabilities: ["provider.register"],
      setup(context) { context.registerProvider({ name: "oversized", async invoke() { return "x".repeat(20_000); } }); }
    };\n`,
  });
  const harness = new Harness();
  await loadPlugins([{ path: "./plugin.mjs", limits: { maxMessageBytes: 4_096 } }], harness, root);
  await assert.rejects(
    () => harness.providers.get("oversized").invoke({
      runId: "run", agent: {}, input: "go", metadata: {}, instructions: [], skills: [],
    }),
    (error) => error.code === "plugin_output_limit",
  );
  await harness.close();
});

test("a crashing plugin is contained and a later worker can still load", async () => {
  const root = await pluginDirectory("crash", {
    "crash.mjs": `process.exit(23);\n`,
    "healthy.mjs": `export default {
      apiVersion: 1, name: "healthy", version: "1.0.0", capabilities: ["instruction.add"],
      setup(context) { context.addInstruction("still-running"); }
    };\n`,
  });
  await assert.rejects(() => loadPlugins(["./crash.mjs"], new Harness(), root));
  const harness = new Harness();
  await loadPlugins(["./healthy.mjs"], harness, root);
  assert.deepEqual(harness.instructions, ["still-running"]);
  await harness.close();
});

async function pluginDirectory(name, files) {
  const root = await mkdtemp(join(tmpdir(), `etnpilot-plugin-${name}-`));
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(root, path), content)));
  return root;
}
