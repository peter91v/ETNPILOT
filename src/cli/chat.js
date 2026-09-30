import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { PolicyEngine } from "../policy/engine.js";
import { describeRequest, display } from "../core/terminal-approval.js";
import { git } from "../git/command.js";
import { openProjectState } from "../runtime/project-state.js";
import { createSessionId, listSessions, readSession, runChatTurn } from "../runtime/chat-session.js";
import { resolveAttachments } from "../runtime/chat-attachments.js";
import { createChoice, overrideOf, runChatCommand } from "../runtime/chat-commands.js";

// 'etnpilot chat': a conversation with an agent, in the terminal.
//
// It is a line of input and a stream of output over the same run a workflow
// makes — the same policy, the same approvals, the same sealed receipt for
// every turn. Everything a person can change here (which agent, which model,
// how hard it thinks, which files) is a choice about one turn's inputs; none of
// it can widen what the policy allows, because the policy is asked after the
// choice, not before.

export async function runChat({
  root = process.cwd(),
  agent,
  resume,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  // For tests: run without a terminal on the other end.
  interactive = Boolean(input.isTTY && output.isTTY),
  runner,
  providerFactories,
} = {}) {
  if (!interactive) {
    throw new Error("Chat needs an interactive terminal. For a single request use 'etnpilot run'.");
  }
  const projectRoot = resolve(root);
  const config = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"), env);
  const policy = new PolicyEngine(config.policy);
  const state = await openProjectState({ root: projectRoot, env });
  const say = (text = "") => output.write(`${text}\n`);

  const known = await state.agents();
  const names = known.agents.filter((entry) => !entry.error).map((entry) => entry.name);
  const chosen = agent ?? known.defaultAgent ?? "orchestrator";
  if (!names.includes(chosen)) {
    state.close();
    throw new Error(`Unknown agent '${chosen}'. This project has: ${names.join(", ") || "none"}.`);
  }

  let sessionId;
  if (resume) {
    const sessions = await listSessions(projectRoot);
    sessionId = resume === "last" ? sessions[0]?.id : resume;
    if (!sessionId || !(await readSession(projectRoot, sessionId)).exists) {
      state.close();
      throw new Error(resume === "last" ? "There is no conversation to resume." : `No conversation '${resume}'.`);
    }
  }
  const choice = createChoice(chosen);

  const readline = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  let closed = false;
  // Lines are queued as they arrive: a person may type the next message while a
  // turn is still running, and readline would otherwise drop it.
  const lines = [];
  const waiting = [];
  readline.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  readline.once("close", () => {
    closed = true;
    for (const waiter of waiting.splice(0)) waiter(undefined);
  });
  const ask = (prompt) => {
    readline.setPrompt(prompt);
    readline.prompt();
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((done) => waiting.push(done));
  };

  let turnController;
  readline.on("SIGINT", () => {
    if (turnController) {
      turnController.abort(new Error("Interrupted."));
      say("\n(interrupted)");
    } else {
      say("\n(Ctrl-D or /exit leaves)");
      readline.prompt?.();
    }
  });

  // Approvals are answered on the same line the conversation is on, in order,
  // one at a time. 'a' is a yes for this turn only — a turn is a run, and a
  // grant ends with its run.
  let queue = Promise.resolve();
  const approvalHandler = (request, context) => {
    const operation = queue.then(async () => {
      // Whatever was typed ahead is not an answer: a yes has to be given to
      // this request, after seeing it.
      lines.length = 0;
      say(`\n── approval needed ─ ${display(context.agent)} wants: ${display(request.kind ?? "unknown")}${describeRequest(request)}`);
      const answer = String(await ask("   allow? [y]es / [n]o / [a] yes for the rest of this turn: ") ?? "").trim().toLowerCase();
      if (/^(y|yes|j|ja)$/.test(answer)) return { kind: "approve-once" };
      if (/^(a|always)$/.test(answer)) return { kind: "approve-for-run" };
      return { kind: "reject", reason: "Rejected by the user." };
    });
    queue = operation.catch(() => {});
    return operation;
  };

  await announce();

  try {
    while (!closed) {
      const line = await ask("you> ");
      if (line === undefined || closed) break;
      const text = String(line).trim();
      if (text === "") continue;
      if (text.startsWith("/")) {
        if (await command(text)) break;
        continue;
      }
      await turn(text);
    }
  } finally {
    readline.close();
    state.close();
  }
  return 0;

  async function announce() {
    const model = choice.model ?? "the agent's own";
    say(`ETNPilot chat · agent ${choice.agent} · model ${model} · ${sessionId ? `resuming ${sessionId}` : "new conversation"}`);
    const status = await git(["status", "--porcelain"], { cwd: projectRoot }).catch(() => undefined);
    if (status?.stdout) {
      const count = status.stdout.split("\n").filter(Boolean).length;
      say(`Note: ${count} uncommitted change${count === 1 ? "" : "s"} in this directory. The agent works here, not in a copy; every write is still asked for.`);
    }
    say("/help lists the commands.");
  }

  async function turn(text) {
    const { attachments, refused } = await resolveAttachments(text, {
      root: projectRoot,
      authorize: (path) => policy.evaluateOperation({ kind: "read", path }, { agent: choice.agent, workspace: projectRoot }),
    });
    for (const file of attachments) {
      say(`  attached ${file.path}${file.kind === "directory" ? "/ (listing)" : ` (${file.bytes} bytes${file.truncated ? ", cut to fit" : ""})`}`);
    }
    for (const file of refused) say(`  not attached ${file.path}: ${file.reason}`);

    // Fixed before the turn, not taken from its result: a turn that fails still
    // belongs to this conversation, and the next one must find it.
    sessionId ??= createSessionId();
    turnController = new AbortController();
    try {
      const result = await runChatTurn({
        root: projectRoot,
        sessionId,
        text,
        agent: choice.agent,
        attachments,
        runner,
        providerFactories,
        env,
        approvalHandler,
        signal: turnController.signal,
        agentOverride: overrideOf(choice),
      });
      sessionId = result.sessionId;
      say(`\n${choice.agent}> ${result.reply ?? "(no answer)"}`);
      say(`  turn ${result.turn} · ${result.status}${usageLine(result.outcome)}\n`);
    } catch (error) {
      say(`\n! ${error.message}\n`);
    } finally {
      turnController = undefined;
    }
  }

  // True when the conversation should end.
  async function command(text) {
    const result = await runChatCommand(text, { choice, known, config, policy, root: projectRoot, sessionId });
    for (const line of result.lines) say(line);
    if (result.action === "clear") sessionId = undefined;
    return result.action === "exit";
  }
}

function usageLine(outcome) {
  for (const step of Object.values(outcome?.summary?.steps ?? {})) {
    const result = step?.result?.result ?? step?.result;
    const usage = result?.usage;
    if (usage && (usage.inputTokens || usage.outputTokens)) {
      return ` · ${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out${result.model ? ` · ${result.model}` : ""}`;
    }
  }
  return "";
}
