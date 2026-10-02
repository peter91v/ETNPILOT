// @ts-check
import { AUTH_USAGE } from "./auth.js";
import { TRUST_USAGE, guardProject, runTrustCommand } from "./trust.js";
import { agentsCommands } from "./commands/agents.js";
import { configCommands } from "./commands/config.js";
import { graphCommands } from "./commands/graph.js";
import { opsCommands } from "./commands/ops.js";
import { projectCommands } from "./commands/project.js";
import { queueCommands } from "./commands/queue.js";
import { receiptsCommands } from "./commands/receipts.js";
import { securityCommands } from "./commands/security.js";
import { serversCommands } from "./commands/servers.js";
import { modelsCommands } from "./commands/models.js";
import { resumeCommands } from "./commands/resume.js";
import { gcCommands } from "./commands/gc.js";
import { providersCommands } from "./commands/providers.js";
import { usageCommands } from "./commands/usage.js";
import { defaultWaitForShutdown, shouldOpenBrowser } from "./shared.js";

// 'diagnose' moved to the runtime layer, because the TUI and the page run the
// same check; 'etnpilot doctor' is one of its callers, not its home.
export { diagnose } from "../runtime/diagnose.js";
export { shouldOpenBrowser };

// Every command, in the order they are tried. A command is a file under
// src/cli/commands/: an entry says which command line it answers and what it does.
export const COMMANDS = [
  ...projectCommands,
  ...agentsCommands,
  ...graphCommands,
  ...configCommands,
  ...serversCommands,
  ...queueCommands,
  ...receiptsCommands,
  ...securityCommands,
  ...opsCommands,
  ...usageCommands,
  ...modelsCommands,
  ...providersCommands,
  ...gcCommands,
  ...resumeCommands,
];

export const CLI_OPTIONS = Object.freeze({
  help: { type: "boolean", short: "h" },
  depth: { type: "string" },
  root: { type: "string", short: "r", default: "." },
  agent: { type: "string", short: "a" },
  workflow: { type: "string", short: "w" },
  "in-place": { type: "boolean", default: false },
  worktree: { type: "boolean", default: false },
  "no-worktree": { type: "boolean", default: false },
  "cleanup-worktree": { type: "boolean", default: false },
  publish: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  // 'etnpilot ui' opens a browser; both spellings the help names must parse.
  open: { type: "boolean", default: false },
  "no-open": { type: "boolean", default: false },
  events: { type: "string" },
  "for-run": { type: "boolean", default: false },
  scope: { type: "string" },
  cases: { type: "string" },
  resume: { type: "string" },
  continue: { type: "boolean", short: "c", default: false },
  json: { type: "boolean", default: false },
  "rotate-token": { type: "boolean", default: false },
  host: { type: "string" },
  "client-id": { type: "string" },
  trust: { type: "boolean", default: false },
  revoke: { type: "boolean", default: false },
  "allow-host": { type: "string" },
  skip: { type: "string" },
  "key-stdin": { type: "boolean", default: false },
  "no-verify": { type: "boolean", default: false },
  preview: { type: "boolean", default: false },
  gitlab: { type: "boolean", default: false },
  command: { type: "string" },
  port: { type: "string" },
  status: { type: "string" },
  limit: { type: "string" },
  actor: { type: "string" },
  approvals: { type: "string" },
  reason: { type: "string" },
  force: { type: "boolean", default: false },
  "private-key": { type: "string" },
  "public-key": { type: "string", multiple: true },
  "inspect-only": { type: "boolean", default: false },
  "lease-owner": { type: "string" },
  "require-signatures": { type: "boolean", default: false },
  "allow-unsigned": { type: "boolean", default: false },
  "require-terminal": { type: "boolean", default: false },
  "allow-incomplete": { type: "boolean", default: false },
  kind: { type: "string" },
  path: { type: "string" },
  url: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  out: { type: "string", short: "o" },
  template: { type: "string", short: "t" },
  "no-import": { type: "boolean" },
  "no-forge": { type: "boolean" },
  global: { type: "boolean", default: false },
  changed: { type: "boolean", default: false },
  name: { type: "string" },
  "older-than": { type: "string" },
  "allow-drift": { type: "boolean", default: false },
  keep: { type: "string" },
  apply: { type: "boolean", default: false },
  "record-fixtures": { type: "string" },
  raw: { type: "boolean", default: false },
  fixtures: { type: "string" },
});

export const USAGE = `ETNPilot

Usage:
  etnpilot init [directory] [--template default|minimal|regulated] [--no-import] [--no-forge]
  etnpilot run <task> [--agent name | --workflow name] [--root directory] [--approvals terminal|inbox]
    [--events jsonl]
    [--worktree | --no-worktree] [--cleanup-worktree] [--publish] [--dry-run]
    [--record-fixtures file | --fixtures file]
  etnpilot lease recover --lease-owner <uuid> [--root directory]
  etnpilot replay <receipt-file> [--root directory] [--public-key path]
    [--require-signatures] [--inspect-only]
  etnpilot worktree list [--root directory]
  etnpilot worktree cleanup <name> [--root directory]
  etnpilot merge list [--status opened|merged|closed|all] [--root directory]
  etnpilot graph build [directory]
  etnpilot graph dependencies <file> [--root directory]
  etnpilot graph dependents <file> [--root directory]
  etnpilot graph symbols <file> [--root directory]
  etnpilot graph impact <file...> [--depth number] [--root directory]
  etnpilot graph stats [--root directory]
  etnpilot config list [--path prefix] [--changed] [--root directory]
  etnpilot config set <path> <value> [--global] [--root directory]
  etnpilot config unset <path> [--global] [--root directory]
  etnpilot config diff [--root directory]
  etnpilot smoke [--provider name] [--model id] [--skip key,reply,tools,stream,toolstream,forge] [--gitlab] [--json]
  etnpilot forge [--root directory] [--dry-run | --preview]
  etnpilot content lock [--root directory]
  etnpilot content diff [--json] [--root directory]
  etnpilot content verify [--root directory]
  etnpilot webhook serve [--root directory] [--host address] [--port number]
  etnpilot ui [--root directory] [--host address] [--port number] [--no-open] [--rotate-token]
  etnpilot tui [--root directory]
  etnpilot approval list [--status pending|approved|rejected|expired|all] [--limit number]
  etnpilot approval show <id>
  etnpilot approval approve <id> [--actor name] [--reason text] [--for-run] [--scope pattern]
  etnpilot approval reject <id> [--actor name] [--reason text]
  etnpilot queue list [--status status] [--limit number]
  etnpilot queue show <id>
  etnpilot queue resume <id> [--force]
  etnpilot queue cancel <id> [--actor name] [--reason text]
  etnpilot receipt keygen [--private-key path] [--public-key path]
  etnpilot receipt show [file] [--root directory] [--raw]
  etnpilot receipt verify <file> [--public-key path]
    [--require-signatures | --allow-unsigned] [--require-terminal | --allow-incomplete]
  etnpilot secret check <name> [--root directory]
${AUTH_USAGE}
${TRUST_USAGE}
  etnpilot policy check (--kind kind [--path path | --url url | --command "npm test"] | --provider name)
    [--agent name] [--root directory]
  etnpilot pipeline status [ref] [--root directory]
  etnpilot deps check [--root directory]
  etnpilot sbom [--out file] [--root directory]
  etnpilot scan secrets [--root directory]
  etnpilot attest <receipt-file> [--out file] [--root directory]
  etnpilot telemetry summary [workflow-run-id] [--root directory]
  etnpilot provider presets
  etnpilot provider add <preset> [--name name] [--model id] [--force] [--root directory]
  etnpilot resume <run-id|receipt-file> [--dry-run] [--allow-drift] [--approvals terminal|inbox] [--publish] [--public-key path] [--json] [--root directory]
  etnpilot gc [--older-than days] [--keep n] [--apply] [--json] [--root directory]
  etnpilot models [--provider name] [--json]       what the provider offers this account, with known prices
  etnpilot usage [--json] [--root directory]       tokens, requests and cost by model and by day
  etnpilot doctor [--root directory]
  etnpilot check [name...] [--root directory]
  etnpilot chat [--agent name] [--resume <id>|last | --continue] [--root directory]
  etnpilot eval [name...] [--provider name] [--cases directory] [--json]

Exit codes:
  0  the command succeeded
  1  the command failed, or a run, verification, or policy check was rejected
`;

export async function runCli(positionals, values, { waitForShutdown = defaultWaitForShutdown } = /** @type {any} */ ({})) {
  const [command, subcommand, ...rest] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    return 0;
  }

  if (command === "trust") return runTrustCommand(values);
  await guardProject(command, subcommand, values);

  const [entry] = COMMANDS.filter((candidate) => candidate.match({ command, subcommand }));
  if (!entry) throw new Error(`Unknown command: ${positionals.join(" ")}`);
  return (await entry.run(/** @type {any} */ ({ command, subcommand, rest, positionals, values, waitForShutdown }))) ?? 0;
}
