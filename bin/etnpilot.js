#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodeGraph } from "../src/codegraph/codegraph.js";
import { initializeProject } from "../src/config/init.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    database: { type: "string", short: "d" },
  },
});

const [command, subcommand, ...rest] = positionals;

if (values.help || !command) {
  console.log(`ETNPilot

Usage:
  etnpilot init [directory]
  etnpilot graph build [directory] [--database path]
  etnpilot graph dependencies <file> [--database path]
  etnpilot doctor
`);
  process.exit(0);
}

if (command === "init") {
  const result = await initializeProject(resolve(subcommand ?? "."));
  console.log(`Initialized ETNPilot in ${result.root}`);
} else if (command === "graph" && subcommand === "build") {
  const root = resolve(rest[0] ?? ".");
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    const result = await graph.indexDirectory(root);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    graph.close();
  }
} else if (command === "graph" && subcommand === "dependencies") {
  if (!rest[0]) throw new Error("A file path is required.");
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    console.log(JSON.stringify(graph.dependencies(rest[0]), null, 2));
  } finally {
    graph.close();
  }
} else if (command === "doctor") {
  const checks = {
    node: process.versions.node,
    git: await commandExists("git"),
    copilotSdk: await import("@github/copilot-sdk").then(() => true, () => false),
  };
  console.log(JSON.stringify(checks, null, 2));
  process.exit(checks.git ? 0 : 1);
} else {
  throw new Error(`Unknown command: ${positionals.join(" ")}`);
}

async function commandExists(commandName) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveResult) => {
    const child = spawn(commandName, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}
