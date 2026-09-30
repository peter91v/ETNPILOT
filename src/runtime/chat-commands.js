import { listSessions, readSession } from "./chat-session.js";

// The slash commands of a conversation, in one place.
//
// The terminal chat and the terminal interface's Chat view both have a line of
// input, and a command means the same thing in either: what it accepts, what
// it refuses and what it says. So neither owns them. A command changes one
// choice for the next turn (which agent, model, effort) or asks a question
// (which files, which conversations); none of them can widen what the policy
// allows, because the policy is asked after the choice, not before.

export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high"]);

export const CHAT_HELP = [
  "Type a message and press Enter. Put @path in it to attach a file.",
  "",
  "  /agent [name]        show the agents, or talk to another one",
  "  /model [id]          use another model; 'provider:id' also picks the provider; 'reset' undoes it",
  "  /effort [level]      low, medium or high; 'reset' undoes it",
  "  /undo                take back the file changes of the last turn",
  "  /compact             carry the older turns as a summary (asks the model once)",
  "  /files               the files attached in this conversation",
  "  /sessions            conversations in this project",
  "  /clear               start a new conversation (/new does too)",
  "  /help                this list",
  "  /exit                leave",
].join("\n");

export function createChoice(agent) {
  return { agent, model: undefined, provider: undefined, effort: undefined };
}

// What the run is told to change for the agent it talks to, or nothing.
export function overrideOf(choice) {
  const { model, provider, effort } = choice;
  return model || provider || effort ? { model, provider, effort } : undefined;
}

// Returns { lines, action }. 'action' is "exit" or "clear" when the caller has
// something to do besides print; the choice is changed in place.
export async function runChatCommand(text, { choice, known, config, policy, root, sessionId, undo, compact }) {
  const names = known.agents.filter((entry) => !entry.error).map((entry) => entry.name);
  const [name, ...rest] = text.replace(/^\//, "").split(/\s+/);
  const argument = rest.join(" ").trim();
  const say = (...lines) => ({ lines });

  switch (name) {
    case "exit":
    case "quit":
      return { lines: [], action: "exit" };
    case "help":
      return say(CHAT_HELP);
    case "agent": {
      if (!argument) {
        return say(...known.agents.map((entry) => `${entry.name === choice.agent ? "*" : " "} ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`));
      }
      if (!names.includes(argument)) return say(`No agent '${argument}'. Known: ${names.join(", ")}.`);
      choice.agent = argument;
      choice.model = choice.provider = choice.effort = undefined;
      return say(`Now talking to ${argument}.`);
    }
    case "model":
      return say(setModel(argument, { choice, config, policy }));
    case "effort": {
      if (!argument) return say(`effort: ${choice.effort ?? "the agent's own"}`);
      if (argument === "reset") {
        choice.effort = undefined;
        return say("effort: the agent's own");
      }
      if (EFFORT_LEVELS.includes(argument)) {
        choice.effort = argument;
        return say(`effort: ${argument}`);
      }
      return say("effort is low, medium or high (or reset).");
    }
    case "undo": {
      if (typeof undo !== "function") return say("Undo is not available here.");
      // A failure is a line at the prompt, not the end of the conversation.
      const result = await undo().catch((error) => ({ message: `! ${error.message}` }));
      return say(...result.message.split("\n"));
    }
    case "compact": {
      if (typeof compact !== "function") return say("Compacting is not available here.");
      const result = await compact().catch((error) => ({ message: `! ${error.message}` }));
      return say(...result.message.split("\n"));
    }
    case "files": {
      const session = sessionId ? await readSession(root, sessionId) : { turns: [] };
      const files = session.turns.flatMap((entry) => (entry.attachments ?? []).map((file) => `  turn ${entry.turn}: ${file.path} (${file.bytes} bytes, sha256 ${file.digest.slice(0, 12)}${file.truncated ? ", cut" : ""})`));
      return say(files.length > 0 ? files.join("\n") : "No files attached in this conversation.");
    }
    case "sessions": {
      const sessions = await listSessions(root);
      return say(sessions.length > 0
        ? sessions.slice(0, 15).map((entry) => `  ${entry.id}  ${entry.turns} turn${entry.turns === 1 ? "" : "s"}  ${entry.preview}`).join("\n")
        : "No conversations yet.");
    }
    case "clear":
    case "new":
      return { lines: ["New conversation. The earlier one stays on disk."], action: "clear" };
    default:
      return say(`Unknown command '/${name}'. /help lists them.`);
  }
}

function setModel(argument, { choice, config, policy }) {
  if (!argument) return `model: ${choice.model ?? "the agent's own"}${choice.provider ? ` on ${choice.provider}` : ""}`;
  if (argument === "reset") {
    choice.model = choice.provider = undefined;
    return "model: the agent's own";
  }
  const [head, ...tail] = argument.split(":");
  const provider = tail.length > 0 ? head : undefined;
  const model = tail.length > 0 ? tail.join(":") : argument;
  // Asked now so a refusal is a sentence at the prompt and not a failed turn.
  // The router asks again before anything is sent: this is a courtesy, the
  // policy is the authority.
  if (provider) {
    const verdict = policy.evaluateProvider(provider, { agent: choice.agent });
    if (verdict.allowed === false) {
      return `Refused: ${verdict.reason ?? `the policy does not allow provider '${provider}'.`}`;
    }
    if (!config.providers?.[provider]) {
      return `No provider '${provider}' is configured. Configured: ${Object.keys(config.providers ?? {}).join(", ")}.`;
    }
  }
  choice.model = model;
  choice.provider = provider;
  return `model: ${model}${provider ? ` on ${provider}` : ""}`;
}
