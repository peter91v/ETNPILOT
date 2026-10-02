// @ts-check
import { createInterface } from "node:readline/promises";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireTrust, revokeTrust, trustProject, trustState } from "../trust/trust.js";

// 'etnpilot trust' and the gate in front of every command that acts on a
// project's configuration. Reading commands (doctor, config, receipts, the
// content lock, login) never ask: they cannot send or run anything.

export const TRUST_USAGE = `  etnpilot trust [--revoke] [--root directory]      look at what this project can do, and trust it (or stop trusting it)
  (commands that act on a project ask once; --trust answers yes, ETNPILOT_TRUST=all skips the question in a pipeline)`;

const ACTING = new Set(["run", "resume", "replay", "smoke", "forge", "tui", "ui", "chat", "eval", "check"]);
const ACTING_WITH_SUBCOMMAND = new Set(["webhook serve", "queue resume", "pipeline status"]);

export function needsTrust(command, subcommand) {
  return ACTING.has(command) || ACTING_WITH_SUBCOMMAND.has(`${command} ${subcommand}`);
}

async function projectExists(root) {
  return access(join(root, ".etnpilot", "etnpilot.yaml")).then(() => true, () => false);
}

function askYesNo(stdin, stdout) {
  if (!stdin.isTTY) return undefined;
  return async (question) => {
    const lines = createInterface({ input: stdin, output: stdout });
    try {
      return /^y(es)?$/i.test((await lines.question(question)).trim());
    } finally {
      lines.close();
    }
  };
}

export async function guardProject(command, subcommand, values, { env = process.env, stdin = process.stdin, stdout = process.stdout } = /** @type {any} */ ({})) {
  // The plan only reads; it is resuming that acts.
  if (command === "resume" && values["dry-run"] === true) return;
  if (!needsTrust(command, subcommand)) return;
  const root = resolve(values.root ?? ".");
  if (!(await projectExists(root))) return;
  await requireTrust(root, {
    env,
    accept: values.trust === true,
    ask: askYesNo(stdin, stdout),
    say: (line) => stdout.write(`${line}\n`),
  });
}

export async function runTrustCommand(values, { env = process.env, stdin = process.stdin, stdout = process.stdout } = /** @type {any} */ ({})) {
  const say = (line = "") => stdout.write(`${line}\n`);
  const root = resolve(values.root ?? ".");
  if (!(await projectExists(root))) throw new Error(`No project at ${root} (no .etnpilot/etnpilot.yaml).`);
  if (values.revoke) {
    say((await revokeTrust(root, { env })) ? "This project is no longer trusted." : "This project was not trusted.");
    return 0;
  }
  const state = await trustState(root, { env });
  say(state.trusted ? "This project is trusted. What it can do:" : state.changed ? "Trusted before, but it has changed since. What it can do now:" : "Not trusted yet. What it can do:");
  for (const line of state.authority.summary) say(`  - ${line}`);
  say(`  (${state.authority.files.length} configuration/plugin file(s) under .etnpilot/ are part of this)`);
  if (state.trusted) return 0;
  const ask = askYesNo(stdin, stdout);
  const accepted = values.trust === true || (ask ? await ask("Trust this project? [y/N] ") : false);
  if (!accepted) {
    say("Not trusted. (Run again on a terminal, or pass --trust.)");
    return 1;
  }
  await trustProject(root, { env });
  say("Trusted.");
  return 0;
}
