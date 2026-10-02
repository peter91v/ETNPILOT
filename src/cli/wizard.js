// @ts-check
import { createInterface } from "node:readline/promises";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectTemplates } from "../runtime/first-run.js";
import { chooseDefaultProvider, connectGitLab, gitlabState, providerChoices } from "../runtime/guided-setup.js";
import { initializeProject } from "../config/init.js";
import { loadConfig } from "../config/load.js";
import { writeContentLock } from "../content/provenance.js";
import { trustProject } from "../trust/trust.js";
import { readSecret, runAuthCommand } from "./auth.js";

// 'etnpilot init' on a terminal: the same few things a person would otherwise
// set one by one, asked in order, each with an answer already offered. Every
// step can be skipped and done later; nothing is written that was not asked for.

export function terminalPrompter({ stdin = process.stdin, stdout = process.stdout } = /** @type {any} */ ({})) {
  // One question, one interface: the hidden entry of a token needs the terminal
  // to itself, so nothing stays open between questions.
  const ask = async (question, fallback = "") => {
    const lines = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await lines.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer === "" ? fallback : answer;
    } finally {
      lines.close();
    }
  };
  return {
    ask,
    async confirm(question, fallback = true) {
      const answer = (await ask(`${question} (${fallback ? "Y/n" : "y/N"})`)).toLowerCase();
      return answer === "" ? fallback : answer.startsWith("y") || answer.startsWith("j");
    },
    secret: (question, hint) => readSecret(question, { stdin, stdout, hint }),
  };
}

async function pick(prompter, say, question, options, fallbackIndex) {
  options.forEach((option, index) => say(`  ${index + 1}) ${option}`));
  for (;;) {
    const answer = await prompter.ask(question, String(fallbackIndex + 1));
    const index = Number.parseInt(answer, 10) - 1;
    if (index >= 0 && index < options.length) return index;
    say(`Enter a number from 1 to ${options.length}.`);
  }
}

export async function runInitWizard(directory, { prompter = terminalPrompter(), stdout = process.stdout, env = process.env, fetchImpl, login = runAuthCommand, onProgress } = /** @type {any} */ ({})) {
  const say = (line = "") => stdout.write(`${line}\n`);
  const root = resolve(directory);
  const configFile = join(root, ".etnpilot", "etnpilot.yaml");
  say("ETNPilot setup — three short steps. Enter takes the suggested answer; everything can be changed later.\n");

  say("1/3  The project");
  if (await access(configFile).then(() => true, () => false)) {
    say(`  There is already a project in ${root}; it is kept as it is.\n`);
  } else {
    const templates = projectTemplates();
    const index = await pick(prompter, say, "Template", templates.map((entry) => `${entry.id.padEnd(10)}${entry.about}`), 0);
    const result = await initializeProject(root, { template: templates[index].id, importExisting: true, forge: false, onProgress });
    await trustProject(result.root, { env }).catch(() => undefined);
    say(`  Created ${join(".etnpilot", "etnpilot.yaml")} (template: ${result.template}).\n`);
  }

  say("2/3  The model provider");
  await providerStep(prompter, say, { root, env, login });

  say("\n3/3  Publishing to GitLab");
  await gitlabStep(prompter, say, { root, env, fetchImpl });

  say("\nLast: approve the project content you just created, so runs accept it.");
  if (await prompter.confirm("Lock the content now?", true)) {
    const config = await loadConfig(configFile);
    await writeContentLock(root, config);
    say("  Locked (.etnpilot/content-lock.json). Commit .etnpilot/ with it.");
  }
  say("\nDone. Try:  etnpilot run \"<what to do>\"    or open the interface:  etnpilot ui");
  return 0;
}

async function providerStep(prompter, say, { root, env, login }) {
  const { current, options } = await providerChoices({ root, env });
  const usable = options.filter((option) => !option.unavailable);
  if (usable.length === 0) {
    say("  This project has no provider configured. Add one with 'etnpilot provider presets'.");
    return;
  }
  const labels = usable.map((option) => `${option.id.padEnd(16)}${option.ready ? "ready   " : "no login "}${option.note}`);
  const start = Math.max(0, usable.findIndex((option) => option.id === current));
  const chosen = usable[await pick(prompter, say, "Default provider", labels, start)];
  await chooseDefaultProvider(chosen.id, { root, env });
  say(`  Default provider: ${chosen.id} (your own settings, not committed).`);
  if (chosen.ready || !chosen.service) return;
  const how = chosen.method === "device"
    ? "Sign in now (browser code, or a token if there is no OAuth app registered)"
    : "Enter the key now (hidden)";
  if (await prompter.confirm(`  ${chosen.id} has no login yet. ${how}?`, true)) {
    await login("login", chosen.service, { root }, { env, fetchImpl: undefined });
  } else {
    say(`  Later: etnpilot login ${chosen.service}`);
  }
}

async function gitlabStep(prompter, say, { root, env, fetchImpl }) {
  const state = await gitlabState({ root, env });
  if (state.baseUrl && state.project && state.connected && state.helper) {
    say(`  Already set up: ${state.baseUrl}/${state.project}${state.account ? `, signed in as ${state.account}` : ""}.`);
    return;
  }
  if (!(await prompter.confirm("Publish runs as GitLab merge requests?", Boolean(state.baseUrl || state.connected)))) {
    say("  Skipped. Later: etnpilot login gitlab --host <address>, then set git.project and git.remote.");
    return;
  }
  const host = await prompter.ask("  GitLab address", state.baseUrl ?? "https://gitlab.com");
  const project = await prompter.ask("  Project (group/project, or paste its web address)", state.project ?? "");
  const user = await prompter.ask("  GitLab user name", state.account ?? "");
  let token;
  if (state.connected && await prompter.confirm("  A GitLab token is already stored. Keep it?", true)) {
    token = undefined;
  } else {
    token = await prompter.secret("  GitLab token (scope api; profile → Access tokens): ", "The token is kept in your own credentials file, not in the project.");
  }
  try {
    const result = await connectGitLab({ root, env, fetchImpl, host, project, user: user || undefined, token, remote: state.remote });
    for (const line of result.done) say(`  ${line}`);
  } catch (error) {
    say(`  Not set up: ${error.message}`);
    say("  Run 'etnpilot init' again to retry this step.");
  }
}
