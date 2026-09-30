import { truncate } from "./ansi.js";
import { wrap } from "./render.js";

// The Chat view, as lines. Like every renderer here it is a pure function of
// state and viewport: the conversation, the choices made for the next turn and
// whatever the agent is waiting to be told go in, rows of text come out.
//
// The newest lines are at the bottom, where the eye already is, with the
// composer under them. When the agent is waiting on a decision, the decision
// takes the bottom of the screen and the thread gives way: a question that
// scrolled out of sight is a run that looks stuck.

export function renderChat(state, { style, width, height, chat, cursor = 0 }) {
  const choice = chat.choice;
  const head = [
    `agent ${choice.agent ?? "—"}`,
    `model ${choice.model ? `${choice.provider ? `${choice.provider}:` : ""}${choice.model}` : "the agent's own"}`,
    `effort ${choice.effort ?? "the agent's own"}`,
  ].join(" · ");
  const where = chat.sessionId ? chat.sessionId : "new conversation";
  const lines = [style.dim(truncate(`${head} · ${where}`, width)), ""];

  const pending = chat.running || chat.pending ? state.approvals?.pending ?? [] : [];
  const decision = pending.length > 0 ? renderDecision(pending, { style, width, budget: Math.max(6, Math.floor(height / 2)), cursor }) : [];

  const room = Math.max(1, height - lines.length - decision.length);
  const thread = threadLines(chat, { style, width });
  // Anchored to the newest line; PageUp moves the window back through the past.
  const end = Math.max(room, thread.length - Math.max(0, chat.scroll ?? 0));
  const start = Math.max(0, end - room);
  const shown = thread.slice(start, end);
  if (start > 0) shown[0] = style.dim(`↑ ${start} earlier line${start === 1 ? "" : "s"} (PageUp)`);
  lines.push(...shown);
  while (lines.length < height - decision.length) lines.push("");
  lines.push(...decision);
  return lines.slice(0, height);
}

function threadLines(chat, { style, width }) {
  const lines = [];
  const say = (label, text, tone) => {
    const inner = Math.max(10, width - 6);
    wrap(text ?? "", inner).forEach((piece, index) => {
      lines.push(`${index === 0 ? style.tone(label.padEnd(5), tone) : "     "} ${tone === "muted" ? style.muted(piece) : style.ink(piece)}`);
    });
  };
  if (chat.turns.length === 0 && !chat.pending) {
    lines.push(style.dim("Say what you want done. Press enter to write; @ names a file;"));
    lines.push(style.dim("/help lists the commands. Every write and command still asks you first."));
  }
  for (const turn of chat.turns) {
    say("you", turn.input, "accent");
    for (const file of turn.attachments ?? []) {
      lines.push(`      ${style.dim(`attached ${file.path}${file.kind === "directory" ? "/" : ""}${file.truncated ? " (cut)" : ""}`)}`);
    }
    if (turn.status === "succeeded") {
      say("agent", turn.reply ?? "", "ok");
      lines.push(`      ${style.dim(`turn ${turn.turn}${turn.runId ? ` · run ${turn.runId.slice(0, 8)}` : ""}${turn.historyOmitted ? ` · ${turn.historyOmitted} earlier exchange(s) left out` : ""}`)}`);
    } else {
      say("agent", turn.error ?? `The turn ended ${turn.status}.`, "bad");
    }
    lines.push("");
    const summary = (chat.compactions ?? []).find((entry) => entry.upToTurn === turn.turn);
    if (summary) {
      lines.push(style.dim(`── turns up to ${summary.upToTurn} are carried as a summary from here on ──`), "");
    }
  }
  if (chat.pending) {
    say("you", chat.pending.text, "accent");
    for (const file of chat.pending.attached ?? []) lines.push(`      ${style.dim(`attached ${file.path}`)}`);
    for (const file of chat.pending.refused ?? []) lines.push(`      ${style.warn(`not attached ${file.path}: ${file.reason}`)}`);
    if (chat.pending.lost) {
      lines.push(`${style.tone("agent", "bad")} ${style.bad("This turn left no record. Check the runs view for why it stopped.")}`);
    } else if (chat.partial) {
      // The answer as it forms; the record replaces it when the turn ends.
      say("agent", chat.partial, "ok");
      lines.push(`      ${style.dim("writing…")}`);
    } else {
      lines.push(`${style.tone("agent", "ok")} ${style.dim("working…")}`);
    }
  }
  for (const note of chat.notes ?? []) {
    for (const piece of wrap(note, Math.max(10, width - 2))) lines.push(style.muted(piece));
  }
  return lines;
}

// What the agent is asking, with what it would change. The keys that answer it
// are the ones the approvals view already has.
function renderDecision(pending, { style, width, budget, cursor }) {
  const index = Math.min(Math.max(0, cursor), pending.length - 1);
  const approval = pending[index];
  const details = approval.details ?? {};
  const out = [style.dim("─".repeat(Math.max(1, width - 1)))];
  const more = pending.length > 1 ? ` · ${index + 1} of ${pending.length} (↑↓)` : "";
  out.push(`${style.bold(style.warn(String(approval.operationKind ?? "?").toUpperCase()))} ${style.dim(`${approval.agent ?? "agent"} is waiting for you${more}`)}`);
  const subject = details.command ?? details.url ?? details.file ?? details.tool ?? "(no detail recorded)";
  out.push(`  ${style.ink(truncate(String(subject), width - 3))}`);
  if (details.diff) {
    let used = out.length + 1;
    for (const line of String(details.diff).split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++") || line === "") continue;
      if (used >= budget) {
        out.push(style.dim("  … the rest is in the approvals view (enter opens it there)"));
        break;
      }
      const tone = line.startsWith("+") ? "ok" : line.startsWith("-") ? "bad" : "muted";
      out.push(`  ${style.tone(truncate(line, width - 4), tone)}`);
      used += 1;
    }
  }
  out.push(`  ${style.accent("a")} ${style.dim("approve once")}  ${style.accent("r")} ${style.dim("reject")}`);
  return out;
}
