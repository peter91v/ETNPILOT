// @ts-check
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { setSetting } from "../../config/settings.js";
import { PRESETS, presetSettings } from "../../providers/presets.js";

// Adding a provider without writing YAML.

export const providersCommands = [
  {
    match: ({ command, subcommand }) => command === "provider" && (subcommand === "presets" || subcommand === undefined),
    async run() {
      for (const [name, preset] of Object.entries(PRESETS)) {
        console.log(`${name.padEnd(11)}${preset.label}`);
        console.log(`${"".padEnd(11)}${preset.baseUrl}  (key: ${preset.env ?? "none"})`);
      }
      console.log("\nAdd one with: etnpilot provider add <preset> [--name <name>] [--model <id>]");
    },
  },
  {
    match: ({ command, subcommand }) => command === "provider" && subcommand === "add",
    async run({ rest, values }) {
      const [preset] = rest;
      if (!preset) throw new Error("Usage: etnpilot provider add <preset> [--name name] [--model id] — see 'etnpilot provider presets'.");
      const root = resolve(values.root);
      // The key's mapping must be in the committed file; a provider without a
      // key can live in the user's own file.
      const entry = PRESETS[preset];
      const project = Boolean(entry?.env);
      const { id, secret, settings } = presetSettings(preset, values.name, { project });
      const existing = (await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(() => ({}))).providers ?? {};
      if (existing[id] && !values.force) throw new Error(`The project already has a provider '${id}'. Use --name for another name, or --force to replace it.`);
      if (values.model) settings[0][1].model = values.model;
      const scope = project ? "project" : "local";
      for (const [path, value] of settings) await setSetting(path, value, { root, scope });
      if (project) await allowEnvKey(root, entry.env);
      console.log(`Added provider '${id}' (${entry.label}) to ${scope === "project" ? ".etnpilot/etnpilot.yaml" : "your local settings"}.`);
      if (entry.env) {
        console.log(`Set ${entry.env} in your environment, then: etnpilot smoke --provider ${id}`);
        console.log(`Secret '${secret}' is read from ${entry.env} only; no login is stored for it.`);
        console.log("The committed file changed, so run 'etnpilot trust' to look at it again.");
      } else {
        console.log(`Start the server, then: etnpilot models --provider ${id}   (the model '${settings[0][1].model}' is a guess)`);
      }
    },
  },
];

// secrets.providers.env.allow is a list; setSetting replaces a value, so the
// list is read, extended and written back.
async function allowEnvKey(root, key) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const allow = config.secrets?.providers?.env?.allow ?? [];
  if (allow.includes(key)) return;
  await setSetting("secrets.providers.env.allow", [...allow, key], { root, scope: "project" });
}
