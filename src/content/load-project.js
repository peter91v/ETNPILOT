import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { loadConfig } from "../config/load.js";
import { loadPlugins } from "../plugins/load-plugin.js";
import { loadPinnedProjectContent } from "./provenance.js";

export async function loadProject(harness, root = process.cwd(), env = process.env, runtime = {}) {
  const projectRoot = resolve(root);
  const etnRoot = join(projectRoot, ".etnpilot");
  const config = await loadConfig(join(etnRoot, "etnpilot.yaml"), env);
  const { snapshot, evidence } = await loadPinnedProjectContent(projectRoot, config);

  for (const item of snapshot.items.filter(({ type }) => type === "instruction")) {
    harness.instructions.push(item.content);
  }
  for (const item of snapshot.items.filter(({ type }) => type === "prompt")) {
    harness.prompts.register(item.name, item.content);
  }
  for (const item of snapshot.items.filter(({ type }) => type === "skill")) {
    harness.skills.register(item.name, { name: item.name, content: item.content, directory: dirname(item.absolutePath) });
  }
  for (const item of snapshot.items.filter(({ type }) => type === "agent")) {
    const manifest = YAML.parse(item.content);
    const prompt = manifest.promptRef
      ? harness.prompts.get(manifest.promptRef)
      : manifest.prompt;
    harness.registerAgent({ ...manifest, prompt });
  }
  const pluginEntries = runtime.bootstrapPluginsLoaded
    ? (config.plugins ?? []).filter((entry) => !isBootstrapPlugin(entry))
    : (config.plugins ?? []);
  if (pluginEntries.length > 0) {
    await loadPlugins(pluginEntries, harness, projectRoot, {
      isolation: config.pluginIsolation,
      signal: runtime.signal,
      secretResolver: runtime.secretResolver,
      fetchImpl: runtime.fetchImpl,
    });
  }
  return { root: projectRoot, config, content: evidence };
}

function isBootstrapPlugin(entry) {
  return entry && typeof entry === "object" && entry.bootstrap === true;
}
