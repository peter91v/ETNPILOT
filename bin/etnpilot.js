#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodeGraph } from "../src/codegraph/codegraph.js";
import { initializeProject } from "../src/config/init.js";
import { createTerminalApprovalHandler } from "../src/core/terminal-approval.js";
import { WorktreeManager } from "../src/git/worktrees.js";
import { createGitLabWebhookServer } from "../src/gitlab/webhook-server.js";
import { runProject } from "../src/runtime/project-runner.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    database: { type: "string", short: "d" },
    depth: { type: "string" },
    root: { type: "string", short: "r", default: "." },
    agent: { type: "string", short: "a" },
    "in-place": { type: "boolean", default: false },
    worktree: { type: "boolean", default: false },
    "no-worktree": { type: "boolean", default: false },
    "cleanup-worktree": { type: "boolean", default: false },
    publish: { type: "boolean", default: false },
    host: { type: "string" },
    port: { type: "string" },
  },
});

const [command, subcommand, ...rest] = positionals;

if (values.help || !command) {
  console.log(`ETNPilot

Usage:
  etnpilot init [directory]
  etnpilot run <task> [--agent name] [--root directory]
    [--worktree | --no-worktree] [--cleanup-worktree] [--publish]
  etnpilot worktree list [--root directory]
  etnpilot worktree cleanup <name> [--root directory]
  etnpilot graph build [directory] [--database path]
  etnpilot graph dependencies <file> [--database path]
  etnpilot graph dependents <file> [--database path]
  etnpilot graph symbols <file> [--database path]
  etnpilot graph impact <file...> [--depth number] [--database path]
  etnpilot graph stats [--database path]
  etnpilot webhook serve [--root directory] [--host address] [--port number]
  etnpilot doctor
`);
  process.exit(0);
}

if (command === "init") {
  const result = await initializeProject(resolve(subcommand ?? "."));
  console.log(`Initialized ETNPilot in ${result.root}`);
} else if (command === "run") {
  if (values.worktree && (values["no-worktree"] || values["in-place"])) {
    throw new Error("Choose either --worktree or --no-worktree, not both.");
  }
  const task = [subcommand, ...rest].filter(Boolean).join(" ");
  const worktree = values.worktree ? true : (values["no-worktree"] || values["in-place"]) ? false : undefined;
  const result = await runProject({
    root: resolve(values.root),
    input: task,
    agent: values.agent,
    worktree,
    cleanupPolicy: values["cleanup-worktree"] ? "on-success" : undefined,
    publish: values.publish,
    approvalHandler: createTerminalApprovalHandler(),
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "worktree" && subcommand === "list") {
  const manager = new WorktreeManager(resolve(values.root));
  console.log(JSON.stringify(await manager.list(), null, 2));
} else if (command === "worktree" && subcommand === "cleanup") {
  if (!rest[0]) throw new Error("A worktree name is required.");
  const manager = new WorktreeManager(resolve(values.root));
  console.log(JSON.stringify(await manager.removeIfClean(rest[0]), null, 2));
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
} else if (command === "graph" && subcommand === "dependents") {
  if (!rest[0]) throw new Error("A file path is required.");
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    console.log(JSON.stringify(graph.dependents(rest[0]), null, 2));
  } finally {
    graph.close();
  }
} else if (command === "graph" && subcommand === "symbols") {
  if (!rest[0]) throw new Error("A file path is required.");
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    console.log(JSON.stringify(graph.symbols(rest[0]), null, 2));
  } finally {
    graph.close();
  }
} else if (command === "graph" && subcommand === "impact") {
  if (rest.length === 0) throw new Error("At least one changed file is required.");
  const maxDepth = values.depth === undefined ? 20 : Number.parseInt(values.depth, 10);
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    console.log(JSON.stringify(graph.impact(rest, { maxDepth }), null, 2));
  } finally {
    graph.close();
  }
} else if (command === "graph" && subcommand === "stats") {
  const database = resolve(values.database ?? ".etnpilot/state/codegraph.sqlite");
  const graph = new CodeGraph(database);
  try {
    console.log(JSON.stringify(graph.stats(), null, 2));
  } finally {
    graph.close();
  }
} else if (command === "webhook" && subcommand === "serve") {
  const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  const webhookServer = await createGitLabWebhookServer({ root: resolve(values.root) });
  const address = await webhookServer.listen({ host: values.host, port });
  const displayHost = typeof address === "object" ? address.address : values.host;
  const displayPort = typeof address === "object" ? address.port : port;
  console.log(`ETNPilot GitLab webhook receiver listening on http://${displayHost}:${displayPort}`);
  await waitForShutdown();
  await webhookServer.drain();
  await webhookServer.close();
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

function waitForShutdown() {
  return new Promise((resolveShutdown) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function commandExists(commandName) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveResult) => {
    const child = spawn(commandName, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}
