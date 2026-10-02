// @ts-check
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { AUTHOR_KINDS, IMPROVE_KINDS, applyDraft, draftImprovement, draftNew, listItems, renderDiff } from "../forge/author.js";
import { terminalPrompter } from "./wizard.js";

// 'etnpilot author': drafting an agent, skill, instruction or an improved
// prompt with a model's help. Always shows the draft first and writes only after
// a yes; a script says --yes, or --dry-run to see the draft and stop.

export const AUTHOR_USAGE = `  etnpilot author                                  asks what you need (agent, skill, instruction, or improving one) and drafts it with a model
  etnpilot author <agent|skill|instruction|prompt> "<what you need>" [--yes] [--dry-run]
  etnpilot author improve <prompt|skill|instruction> <name> "<what to change>" [--yes] [--dry-run]
                                                  uses forge.provider and forge.model; nothing is written until you accept`;

export async function runAuthorCommand(subcommand, rest, values, { prompter, stdin = process.stdin, stdout = process.stdout, env = process.env, fetchImpl, runModel, factories } = /** @type {any} */ ({})) {
  const say = (line = "") => stdout.write(`${line}\n`);
  const root = resolve(values.root ?? ".");
  const interactive = Boolean(stdin.isTTY) || Boolean(prompter);
  const ask = prompter ?? (interactive ? terminalPrompter({ stdin, stdout }) : undefined);
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const options = { root, config, env, fetchImpl, runModel, factories };

  const [kind, ...words] = [subcommand, ...rest];
  if (kind === undefined) {
    if (!ask) throw new Error("Say what to write: etnpilot author <agent|skill|instruction> \"<what you need>\".");
    return await menu(ask, say, options, values);
  }
  if (kind === "improve") {
    const [target, name, ...request] = words;
    if (!IMPROVE_KINDS.includes(target) || !name) throw new Error(`Use: etnpilot author improve <${IMPROVE_KINDS.join("|")}> <name> "<what to change>".`);
    const wish = request.join(" ") || (ask ? await ask.ask("What should change") : "");
    return await finish(await draftImprovement(target, name, wish, options), ask, say, values, root);
  }
  if (!AUTHOR_KINDS.includes(kind)) throw new Error(`Unknown kind '${kind}'. Use agent, skill, instruction, or 'improve'.`);
  const wish = words.join(" ") || (ask ? await ask.ask(`What should the ${kind} do`) : "");
  return await finish(await draftNew(kind, wish, options), ask, say, values, root);
}

async function menu(ask, say, options, values) {
  say("What do you need?");
  const choices = ["A new agent", "A new skill", "A new instruction", "A new prompt", "Improve a prompt", "Improve a skill", "Improve an instruction"];
  choices.forEach((choice, index) => say(`  ${index + 1}) ${choice}`));
  let index = -1;
  while (index < 0 || index >= choices.length) index = Number.parseInt(await ask.ask("Number", "1"), 10) - 1;
  if (index < AUTHOR_KINDS.length) {
    const kind = AUTHOR_KINDS[index];
    const wish = await ask.ask(`Describe the ${kind} in a sentence`);
    return await finish(await draftNew(kind, wish, options), ask, say, values, options.root);
  }
  const kind = IMPROVE_KINDS[index - AUTHOR_KINDS.length];
  const names = await listItems(kind, join(options.root, ".etnpilot"));
  if (names.length === 0) { say(`There is no ${kind} to improve yet.`); return 0; }
  names.forEach((entry, position) => say(`  ${position + 1}) ${entry}`));
  let chosen = -1;
  while (chosen < 0 || chosen >= names.length) chosen = Number.parseInt(await ask.ask(`Which ${kind}`, "1"), 10) - 1;
  const name = names[chosen];
  const wish = await ask.ask("What should change");
  return await finish(await draftImprovement(kind, name, wish, options), ask, say, values, options.root);
}

async function finish(draft, ask, say, values, root) {
  if (draft.provider?.name) say(`Drafted with ${draft.provider.name}${draft.provider.model ? ` (${draft.provider.model})` : ""}.`);
  if (draft.provider?.preferred) say(`forge.provider is '${draft.provider.preferred}', which has no key here.`);
  say();
  if (draft.mode === "new") {
    for (const line of draft.preview) say(line);
    for (const note of draft.notes ?? []) say(`Note: ${note}`);
    const item = draft.plan.agents[0] ?? draft.plan.skills[0] ?? draft.plan.instructions[0] ?? draft.plan.prompts[0];
    say();
    say(item.prompt ?? item.body);
  } else {
    say(`${draft.path}${draft.summary ? ` — ${draft.summary}` : ""}`);
    for (const line of renderDiff(draft.diff)) say(line);
  }
  say();
  if (values["dry-run"]) { say("Dry run: nothing was written."); return 0; }
  const accepted = values.yes === true || (ask ? await ask.confirm("Write this?", false) : false);
  if (!accepted) {
    say(ask ? "Nothing was written." : "Nothing was written. Add --yes to accept the draft without asking.");
    return ask ? 0 : 1;
  }
  const result = await applyDraft(draft, { root });
  const written = result.written ?? [...result.agents, ...result.skills, ...result.instructions, ...(result.prompts ?? [])].map((entry) => entry.to);
  for (const skipped of result.skipped ?? []) say(`Skipped ${skipped.name}: ${skipped.reason}.`);
  for (const path of written) say(`Wrote ${path}`);
  if (written.length > 0) say("It is not reviewed yet: read it, then 'etnpilot content lock' and commit it for your team.");
  return 0;
}
