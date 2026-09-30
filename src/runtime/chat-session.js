import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { boundHistory } from "../core/history.js";
import { composeTurnInput, summarizeAttachments } from "./chat-attachments.js";
import { pinSnapshot, snapshotTree, undoBetween } from "./chat-snapshots.js";

// A conversation, kept as the receipts of its turns.
//
// A chat here is not a second system beside the workflow. Every turn is a run:
// the same harness, the same policy, the same approvals, the same sealed
// receipt. What a session adds is only an order — which runs belong together —
// and the text the next turn needs to know what came before. Nothing in this
// file decides anything; it remembers.
//
// One line per turn, appended when the turn ends, in
// '.etnpilot/state/sessions/<id>.jsonl'. The line names the run; the run's
// receipt is the evidence, so what a turn cost, which tools it used and who
// approved what are read from there and not tallied a second time here.

const SESSION_VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function sessionsDirectory(root) {
  return join(root, ".etnpilot", "state", "sessions");
}

export function createSessionId(now = Date.now()) {
  return `s-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
}

function assertId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new TypeError(`'${id}' is not a session id.`);
  }
}

export async function appendTurn(root, sessionId, turn) {
  assertId(sessionId);
  const directory = sessionsDirectory(root);
  await mkdir(directory, { recursive: true });
  const line = { v: SESSION_VERSION, sessionId, ...turn };
  await appendFile(join(directory, `${sessionId}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return line;
}

export async function readSession(root, sessionId) {
  assertId(sessionId);
  let text;
  try {
    text = await readFile(join(sessionsDirectory(root), `${sessionId}.jsonl`), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { id: sessionId, exists: false, turns: [] };
    throw error;
  }
  const turns = [];
  for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
    try {
      const entry = JSON.parse(line);
      // An undo is a note about a turn, not a turn: it marks the turn it took back.
      if (entry.type === "undo") {
        const undone = turns.find((turn) => turn.turn === entry.turn);
        if (undone) undone.undone = { at: entry.at, reverted: entry.reverted, skipped: entry.skipped };
        continue;
      }
      turns.push(entry);
    } catch {
      // A line that does not parse is reported, not skipped: a session that
      // quietly lost a turn would give the next one the wrong past.
      throw new Error(`Session ${sessionId}, line ${index + 1}, is not valid JSON.`);
    }
  }
  return { id: sessionId, exists: true, turns };
}

export async function listSessions(root) {
  let names;
  try {
    names = await readdir(sessionsDirectory(root));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sessions = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const id = name.slice(0, -".jsonl".length);
    if (!ID_PATTERN.test(id)) continue;
    const { turns } = await readSession(root, id);
    const last = turns.at(-1);
    sessions.push({
      id,
      turns: turns.length,
      startedAt: turns[0]?.at,
      lastAt: last?.at,
      agent: last?.agent,
      preview: String(turns[0]?.input ?? "").slice(0, 80),
    });
  }
  return sessions.sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)));
}

// What the next turn is told about the past: what the person said and what
// the agent answered. A turn that failed produced no answer, so it has no
// place in the memory — it stays in the log, where it can be read.
export function historyFrom(turns) {
  const messages = [];
  for (const turn of turns) {
    if (turn.status !== "succeeded" || typeof turn.reply !== "string") continue;
    // The files themselves are not carried: the model is told there were some,
    // and by digest which, and can read them again if it needs them.
    const attached = (turn.attachments ?? []).length > 0
      ? `\n\n[attached: ${turn.attachments.map((file) => `${file.path} (sha256 ${file.digest.slice(0, 12)})`).join(", ")}]`
      : "";
    const undone = turn.undone
      ? "\n\n[The user undid this turn's changes to the files; they are not in the workspace any more.]"
      : "";
    messages.push({ role: "user", content: `${turn.input}${attached}` }, { role: "assistant", content: `${turn.reply}${undone}` });
  }
  return messages;
}

// The agent's answer, wherever this run kept it.
export function replyOf(outcome) {
  for (const step of Object.values(outcome?.summary?.steps ?? {})) {
    const result = step?.result?.result ?? step?.result;
    if (typeof result?.text === "string") return result.text;
  }
  return undefined;
}

export async function runChatTurn({
  root,
  sessionId,
  text,
  agent,
  runner,
  // Files the person attached, already resolved and authorised
  // (chat-attachments.js), so the caller has shown them what was and was not sent.
  attachments = [],
  now = () => new Date(),
  ...runOptions
} = {}) {
  if (typeof text !== "string" || text.trim() === "") throw new TypeError("A chat turn needs some text.");
  const id = sessionId ?? createSessionId();
  assertId(id);
  const prior = await readSession(root, id);
  const number = prior.turns.length + 1;
  const bounded = boundHistory(historyFrom(prior.turns));
  const run = runner ?? (await import("./project-runner.js")).runProject;
  const at = now().toISOString();

  // The files before the turn, so it can be taken back. Outside a repository
  // there is nothing to record, and the turn says that rather than nothing.
  const dryRun = runOptions.dryRun === true;
  const before = dryRun ? undefined : await snapshotTree(root).catch(() => undefined);
  if (before) await pinSnapshot(root, before, `${id}/${number}-before`).catch(() => {});

  let outcome;
  try {
    outcome = await run({
      root,
      input: composeTurnInput(text, attachments),
      agent,
      // A conversation works where the person is. The approvals are the
      // boundary; a worktree per sitting would take the immediacy out of it.
      worktree: false,
      ...runOptions,
      session: { id, turn: number, history: bounded.history, attachments: summarizeAttachments(attachments) },
    });
  } catch (error) {
    await appendTurn(root, id, {
      turn: number,
      at,
      agent,
      input: text,
      ...(attachments.length > 0 ? { attachments: summarizeAttachments(attachments) } : {}),
      status: "failed",
      error: error.message,
      ...(error.run?.runId ? { runId: error.run.runId } : {}),
    });
    throw error;
  }
  const after = before ? await snapshotTree(root).catch(() => undefined) : undefined;
  if (after) await pinSnapshot(root, after, `${id}/${number}-after`).catch(() => {});
  const reply = replyOf(outcome);
  const status = outcome.status === "succeeded" && reply !== undefined ? "succeeded" : outcome.status ?? "failed";
  const turn = await appendTurn(root, id, {
    turn: number,
    at,
    agent,
    input: text,
    ...(attachments.length > 0 ? { attachments: summarizeAttachments(attachments) } : {}),
    runId: outcome.runId,
    status,
    snapshots: before && after ? { before, after } : { unavailable: dryRun ? "a dry run" : "not a git repository" },
    ...(reply !== undefined ? { reply } : {}),
    ...(bounded.omitted > 0 ? { historyOmitted: bounded.omitted } : {}),
  });
  return { sessionId: id, turn: number, reply, status, record: turn, outcome };
}

// Whether the conversation is what it claims to be: every turn's run has a
// receipt whose chain holds, and that receipt says it belongs to this turn of
// this session. The second half matters: a session file pointing turn 3 at some
// other, perfectly valid, run would otherwise verify.
export async function verifySession(root, sessionId, { verifyReceipt, readEntries } = {}) {
  const { turns } = await readSession(root, sessionId);
  const results = [];
  for (const turn of turns) {
    if (turn.status === "failed" && !turn.runId) {
      results.push({ turn: turn.turn, ok: true, note: "failed before a run started; nothing to verify" });
      continue;
    }
    const file = `${turn.runId}.jsonl`;
    const report = await verifyReceipt(file);
    const entries = report.valid ? await readEntries(file) : [];
    const belongs = entries.some((entry) => entry.session?.id === sessionId && entry.session?.turn === turn.turn);
    results.push({
      turn: turn.turn,
      runId: turn.runId,
      ok: report.valid === true && belongs,
      note: !report.valid
        ? report.text ?? "the receipt does not verify"
        : belongs ? "receipt verifies and names this turn" : "receipt verifies but does not name this turn of this session",
    });
  }
  return { sessionId, turns: results, valid: results.every((result) => result.ok) };
}

// Takes back the file changes of the newest turn that has not been taken back.
// Reports what it reverted and what it left, and why.
export async function undoLastTurn({ root, sessionId, now = () => new Date() }) {
  if (!sessionId) return { ok: false, message: "There is no conversation yet, so nothing to undo." };
  const { turns } = await readSession(root, sessionId);
  const turn = [...turns].reverse().find((entry) => entry.status === "succeeded" && !entry.undone);
  if (!turn) return { ok: false, message: "No turn is left to undo." };
  if (!turn.snapshots?.before) {
    return { ok: false, message: `Turn ${turn.turn} cannot be undone: no snapshot was taken (${turn.snapshots?.unavailable ?? "an older turn"}).` };
  }
  const result = await undoBetween(root, turn.snapshots.before, turn.snapshots.after);
  await appendTurn(root, sessionId, { type: "undo", turn: turn.turn, at: now().toISOString(), ...result });
  const lines = [];
  if (turn.snapshots.before === turn.snapshots.after) lines.push(`Turn ${turn.turn} changed no files, so there was nothing to take back.`);
  else lines.push(`Turn ${turn.turn}: ${result.reverted.length} file${result.reverted.length === 1 ? "" : "s"} put back${result.reverted.length ? ` (${result.reverted.join(", ")})` : ""}.`);
  for (const file of result.skipped) lines.push(`  left ${file.path}: ${file.reason}`);
  return { ok: true, turn: turn.turn, ...result, message: lines.join("\n") };
}
