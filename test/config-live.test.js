import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { PROJECT_TEMPLATES, initializeProject } from "../src/config/init.js";

// P5.2: a field the generated project writes must be a field some code reads.
// 'subagents:' and the network allow-list were both written by 'init' for
// weeks while nothing consulted them, and a reader could not tell. This is the
// same idea as test/parity.test.js, pointed at configuration.

const src = new URL("../src/", import.meta.url).pathname;

async function sources(directory = src) {
  const texts = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) texts.push(...await sources(path));
    else if (entry.name.endsWith(".js") && !path.endsWith("config/init.js")) texts.push(await readFile(path, "utf8"));
  }
  return texts;
}

// Maps whose keys are names the project chooses, not fields the code defines.
const OPEN_MAPS = new Set(["providers", "routing", "roles", "secrets", "mcpServers", "settings", "modes", "budgets"]);

function keysOf(value, path = [], found = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    found.push({ key, path: [...path, key].join(".") });
    if (path.length < 3 && !OPEN_MAPS.has(key)) keysOf(child, [...path, key], found);
  }
  return found;
}

test("every field a generated project writes is read by some code", async () => {
  const text = (await sources()).join("\n");
  const unread = new Set();
  for (const template of Object.keys(PROJECT_TEMPLATES)) {
    const root = await mkdtemp(join(tmpdir(), `etn-live-${template}-`));
    await initializeProject(root, { template });
    const documents = [YAML.parse(await readFile(join(root, ".etnpilot", "etnpilot.yaml"), "utf8"))];
    const agents = join(root, ".etnpilot", "agents");
    for (const name of await readdir(agents)) {
      if (name.endsWith(".yaml")) documents.push(YAML.parse(await readFile(join(agents, name), "utf8")));
    }
    for (const document of documents) {
      for (const { key, path } of keysOf(document)) {
        if (!/^[A-Za-z_]\w*$/.test(key)) continue;
        // Read as a property, or destructured out of an object.
        const read = new RegExp(`[.?]${key}\\b|\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=|\\b${key}\\s*[,}]\\s*=`).test(text);
        if (!read) unread.add(path);
      }
    }
  }
  assert.deepEqual([...unread], [], "these fields are written by 'init' and read by nothing");
});
