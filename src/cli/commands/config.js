// @ts-check
import { briefValue } from "../shared.js";
import { describeSettings, diffSettings, parseSettingValue, setSetting, unsetSetting } from "../../config/settings.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { diffProjectContent, verifyProjectContent, writeContentLock } from "../../content/provenance.js";

// The commands of one area. Each entry says which command line it answers
// ('match') and what it does ('run'); src/cli/commands.js tries them in order.

export const configCommands = [
  {
    match: ({ command, subcommand }) => command === "config" && (subcommand === "list" || subcommand === undefined),
    async run({ values }) {
      const root = resolve(values.root);
      const { entries, layers, overrides, refusals } = await describeSettings({ root });
      const shown = entries
        .filter((entry) => (values.path ? entry.path === values.path || entry.path.startsWith(`${values.path}.`) : true))
        .filter((entry) => (values.changed ? overrides.includes(entry.path) : true));
      console.log(JSON.stringify({ layers, overrides, refusals, settings: shown }, null, 2));
      // A refused setting stops the next run, so listing must not report success.
      if (refusals.length > 0) return 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "config" && subcommand === "set",
    async run({ rest, values }) {
      const [path, ...valueParts] = rest;
      if (!path || valueParts.length === 0) throw new Error("Usage: etnpilot config set <path> <value>");
      const scope = values.global ? "global" : "local";
      const result = await setSetting(path, parseSettingValue(valueParts.join(" ")), { root: resolve(values.root), scope });
      console.log(`${result.path} = ${briefValue(result.effective)} (${scope}, ${result.mode})`);
      console.log(`Written to ${result.file}. This file is yours and is never committed.`);
    },
  },
  {
    match: ({ command, subcommand }) => command === "config" && subcommand === "unset",
    async run({ rest, values }) {
      const [path] = rest;
      if (!path) throw new Error("Usage: etnpilot config unset <path>");
      const scope = values.global ? "global" : "local";
      const result = await unsetSetting(path, { root: resolve(values.root), scope });
      console.log(`${result.path} = ${briefValue(result.effective)} (back to the project default)`);
      console.log(`Written to ${result.file}.`);
    },
  },
  {
    match: ({ command, subcommand }) => command === "config" && subcommand === "diff",
    async run({ values }) {
      const changes = await diffSettings({ root: resolve(values.root) });
      if (changes.length === 0) console.log("No local settings. This project behaves as it was committed.");
      else console.log(JSON.stringify(changes, null, 2));
    },
  },
  {
    match: ({ command, subcommand }) => command === "content" && subcommand === "lock",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      console.log(JSON.stringify(await writeContentLock(root, config), null, 2));
    },
  },
  {
    match: ({ command, subcommand }) => command === "content" && subcommand === "diff",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const diff = await diffProjectContent(root, config);
      if (values.json) console.log(JSON.stringify(diff, null, 2));
      else {
        if (!diff.locked) console.log("There is no content lock yet; everything below would be locked by 'etnpilot content lock'.");
        for (const entry of diff.changed) console.log(`changed  ${entry.path}  (${entry.bytesBefore} -> ${entry.bytesAfter} bytes)`);
        for (const entry of diff.added) console.log(`added    ${entry.path}  (${entry.bytes} bytes)`);
        for (const entry of diff.removed) console.log(`removed  ${entry.path}`);
        const differs = diff.changed.length + diff.added.length + diff.removed.length;
        console.log(differs === 0 ? `Nothing differs from the lock (${diff.unchanged} files).` : `${differs} file(s) differ, ${diff.unchanged} do not. The text: git diff -- ${[...diff.changed, ...diff.removed].map((entry) => entry.path).join(" ") || "<path>"}`);
      }
      return diff.changed.length + diff.added.length + diff.removed.length === 0 ? 0 : 1;
    },
  },
  {
    match: ({ command, subcommand }) => command === "content" && subcommand === "verify",
    async run({ values }) {
      const root = resolve(values.root);
      const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
      const result = await verifyProjectContent(root, config);
      console.log(JSON.stringify(result, null, 2));
      return result.verified ? 0 : 1;
    },
  },
];
