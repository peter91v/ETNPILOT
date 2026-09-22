#!/usr/bin/env node

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodeGraph } from "../src/codegraph/codegraph.js";
import { initializeProject } from "../src/config/init.js";
import { loadConfig } from "../src/config/load.js";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
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
    status: { type: "string" },
    limit: { type: "string" },
    actor: { type: "string" },
    reason: { type: "string" },
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
  etnpilot approval list [--status pending|approved|rejected|expired|all] [--limit number]
  etnpilot approval show <id>
  etnpilot approval approve <id> [--actor name] [--reason text]
  etnpilot approval reject <id> [--actor name] [--reason text]
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
  await webhookServer.close();
  await webhookServer.drain();
} else if (command === "approval" && subcommand === "list") {
  const limit = values.limit === undefined ? 100 : Number.parseInt(values.limit, 10);
  await withApprovalInbox(resolve(values.root), async (inbox) => {
    console.log(JSON.stringify(inbox.list({ status: values.status ?? "pending", limit }), null, 2));
  });
} else if (command === "approval" && subcommand === "show") {
  if (!rest[0]) throw new Error("An approval ID is required.");
  await withApprovalInbox(resolve(values.root), async (inbox) => {
    const approval = inbox.get(rest[0]);
    if (!approval) throw new Error(`Unknown approval '${rest[0]}'.`);
    console.log(JSON.stringify(approval, null, 2));
  });
} else if (command === "approval" && (subcommand === "approve" || subcommand === "reject")) {
  if (!rest[0]) throw new Error("An approval ID is required.");
  await withApprovalInbox(resolve(values.root), async (inbox) => {
    const decision = subcommand === "approve" ? "approved" : "rejected";
    const result = inbox.decide(rest[0], decision, {
      actor: values.actor ?? process.env.USER ?? "cli",
      reason: values.reason,
    });
    console.log(JSON.stringify(result, null, 2));
  });
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

async function withApprovalInbox(root, operation) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const database = resolve(root, config.approval?.inbox?.database ?? ".etnpilot/state/approvals.sqlite");
  const inbox = new ApprovalInbox(database);
  try {
    return await operation(inbox);
  } finally {
    inbox.close();
  }
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
