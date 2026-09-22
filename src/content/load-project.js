import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { loadConfig } from "../config/load.js";
import { loadPlugins } from "../plugins/load-plugin.js";

export async function loadProject(harness, root = process.cwd(), env = process.env, runtime = {}) {
  const projectRoot = resolve(root);
  const etnRoot = join(projectRoot, ".etnpilot");
  const config = await loadConfig(join(etnRoot, "etnpilot.yaml"), env);

  for (const file of await filesIn(join(etnRoot, "instructions"), ".md")) {
    harness.instructions.push(await readFile(file, "utf8"));
  }
  for (const file of await filesIn(join(etnRoot, "prompts"), ".md")) {
    harness.prompts.register(basename(file, ".md"), await readFile(file, "utf8"));
  }
  for (const directory of await directoriesIn(join(etnRoot, "skills"))) {
    const content = await readFile(join(directory, "SKILL.md"), "utf8");
    harness.skills.register(basename(directory), { name: basename(directory), content, directory });
  }
  for (const file of await filesIn(join(etnRoot, "agents"), ".yaml")) {
    const manifest = YAML.parse(await readFile(file, "utf8"));
    const prompt = manifest.promptRef
      ? harness.prompts.get(manifest.promptRef)
      : manifest.prompt;
    harness.registerAgent({ ...manifest, prompt });
  }
  await loadPlugins(config.plugins ?? [], harness, projectRoot, {
    isolation: config.pluginIsolation,
    signal: runtime.signal,
  });
  return { root: projectRoot, config };
}

async function filesIn(directory, extension) {
  const entries = await safeReadDir(directory);
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === extension)
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function directoriesIn(directory) {
  const entries = await safeReadDir(directory);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name)).sort();
}

async function safeReadDir(directory) {
  return readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
