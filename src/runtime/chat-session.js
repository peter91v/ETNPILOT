import { swallow } from "./swallow.js";
import { readRegularFile } from "./bounded-io.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { undoFileEffects } from "./file-effects.js";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { boundHistory } from "../core/history.js";
import { composeTurnInput, summarizeAttachments } from "./chat-attachments.js";
import { pinSnapshot, snapshotTree } from "./chat-snapshots.js";

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
    text = await readRegularFile(join(sessionsDirectory(root), `${sessionId}.jsonl`), 16 * 1024 * 1024).then((bytes) => bytes.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { id: sessionId, exists: false, turns: [], compactions: [] };
    throw error;
  }
  const turns = [];
  const compactions = [];
  for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "compact") {
        compactions.push(entry);
        continue;
      }
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
  return { id: sessionId, exists: true, turns, compactions };
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
export function historyFrom(turns, compactions = []) {
  const messages = [];
  // Once the past has been summarised, the model is given the summary in place
  // of the turns it covers. The turns themselves stay on disk, unchanged.
  const summary = compactions.at(-1);
  if (summary) {
    messages.push(
      { role: "user", content: `[Summary of this conversation up to turn ${summary.upToTurn}, written earlier at the user's request]\n\n${summary.summary}` },
      { role: "assistant", content: "Understood. I will continue from that summary." },
    );
  }
  for (const turn of turns) {
    if (summary && turn.turn <= summary.upToTurn) continue;
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

// What the run cost in tokens, from the result the provider returned.
export function usageOf(outcome) {
  if (outcome?.observability?.summary) return outcome.observability.summary;
  let total;
  const models = new Set();
  for (const step of Object.values(outcome?.summary?.steps ?? {})) {
    const result = step?.result?.result ?? step?.result ?? step?.partialResult;
    const usage = result?.usage ?? step?.usage ?? step?.result?.partialResult?.usage;
    if (!usage) continue;
    total ??= { inputTokens: 0, outputTokens: 0 };
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "requests", "providerUnits"]) {
      if (Number.isFinite(usage[key])) total[key] = (total[key] ?? 0) + usage[key];
    }
    if (result?.model) models.add(result.model);
    if (["partial", "unknown"].includes(usage.usageStatus)) total.usageStatus = "partial";
  }
  return total && { ...total, ...(models.size === 1 ? { model: [...models][0] } : {}) };
}

// What the agent did this turn, in one line each: the tool and what it was asked
// to touch, whether it went through, and why not when it did not. The reply is
// the model's account; this is the record's, and a refusal by policy is visible
// even when the reply glosses over it.
export function callsOf(outcome, limit = 30) {
  const calls = [];
  for (const step of Object.values(outcome?.summary?.steps ?? {})) {
    const result = step?.result?.result ?? step?.result;
    for (const call of result?.toolCalls ?? []) {
      calls.push({
        label: call.label ?? call.tool,
        ok: call.ok === true,
        ...(call.refused ? { refused: call.refused } : {}),
        ...(call.error ? { error: String(call.error).slice(0, 200) } : {}),
      });
    }
  }
  return calls.slice(0, limit);
}

export const DEFAULT_MAX_SESSION_TOKENS = 1_000_000;

// Everything this conversation has spent: its turns and its summaries.
export function sessionTokens(session) {
  const add = (total, entry) => total + (entry.usage?.inputTokens ?? 0) + (entry.usage?.outputTokens ?? 0);
  return [...session.turns, ...(session.compactions ?? [])].reduce(add, 0);
}

// Each turn is a run with its own workflow budget; nothing bounded the
// conversation as a whole, so a long chat could spend without limit one
// affordable turn at a time. This does, and says how to go on.
async function assertWithinBudget(root, session, env) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"), env ?? process.env).catch(swallow("reading the configuration for a chat", undefined));
  const limit = config?.chat?.budget?.maxTotalTokens ?? DEFAULT_MAX_SESSION_TOKENS;
  const used = sessionTokens(session);
  if (used >= limit) {
    throw new Error(
      `This conversation has used ${used} tokens; the limit is ${limit} ('chat.budget.maxTotalTokens').`
      + " Start a new conversation, or raise the limit.",
    );
  }
  return { used, limit };
}

// The agent's answer, wherever this run kept it.
export function replyOf(outcome) {
  for (const step of Object.values(outcome?.summary?.steps ?? {})) {
    const result = step?.result?.result ?? step?.result;
    if (typeof result?.text === "string") return result.text;
  }
  return undefined;
}

async function runChatTurnUnlocked({
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
} = /** @type {any} */ ({})) {
  if (typeof text !== "string" || text.trim() === "") throw new TypeError("A chat turn needs some text.");
  const id = sessionId ?? createSessionId();
  assertId(id);
  const prior = await readSession(root, id);
  await assertWithinBudget(root, prior, runOptions.env);
  const number = prior.turns.length + 1;
  const bounded = boundHistory(historyFrom(prior.turns, prior.compactions));
  const run = runner ?? (await import("./project-runner.js")).runProject;
  const at = now().toISOString();

  // The files before the turn, so it can be taken back. Outside a repository
  // there is nothing to record, and the turn says that rather than nothing.
  const dryRun = runOptions.dryRun === true;
  const before = dryRun ? undefined : await snapshotTree(root).catch(() => undefined);
  if (before) await pinSnapshot(root, before, `${id}/${number}-before`).catch(() => {});

  const effects = new Map();
  const recordFileEffect = (effect) => {
    const previous = effects.get(effect.path);
    if (previous && previous.after !== effect.before) throw new Error("File changed between this turn’s writes; undo attribution is unavailable.");
    effects.set(effect.path, { ...effect, ...(previous ? { before: previous.before, beforeContent: previous.beforeContent } : {}) });
  };
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
      metadata: { ...runOptions.metadata, recordFileEffect },
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
      ...(usageOf({ observability: error.run?.observability, summary: error.workflow }) || error.usage || error.accounting
        ? { usage: usageOf({ observability: error.run?.observability, summary: error.workflow }) ?? error.usage ?? error.accounting } : {}),
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
    ...(usageOf(outcome) ? { usage: usageOf(outcome) } : {}),
    ...(callsOf(outcome).length > 0 ? { calls: callsOf(outcome) } : {}),
    fileEffects: [...effects.values()],
    snapshots: before && after ? { before, after } : { unavailable: dryRun ? "a dry run" : "not a git repository" },
    ...(reply !== undefined ? { reply } : {}),
    ...(bounded.omitted > 0 ? { historyOmitted: bounded.omitted } : {}),
  });
  const totals = { used: sessionTokens({ turns: [...prior.turns, turn], compactions: prior.compactions }) };
  return { sessionId: id, turn: number, reply, status, record: turn, outcome, tokensUsed: totals.used };
}

// Whether the conversation is what it claims to be: every turn's run has a
// receipt whose chain holds, and that receipt says it belongs to this turn of
// this session. The second half matters: a session file pointing turn 3 at some
// other, perfectly valid, run would otherwise verify.
export async function verifySession(root, sessionId, { verifyReceipt, readEntries } = /** @type {any} */ ({})) {
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
    const belongs = entries.some((entry) => entry.session?.id === sessionId && entry.session?.turn === turn.turn && !entry.session?.kind);
    results.push({
      turn: turn.turn,
      runId: turn.runId,
      ok: report.valid === true && belongs,
      note: !report.valid
        ? report.text ?? "the receipt does not verify"
        : belongs ? "receipt verifies and names this turn" : "receipt verifies but does not name this turn of this session",
    });
  }
  // A summary is a run too, and its receipt must say it belongs here.
  for (const compaction of (await readSession(root, sessionId)).compactions) {
    const file = `${compaction.runId}.jsonl`;
    const report = await verifyReceipt(file);
    const entries = report.valid ? await readEntries(file) : [];
    const belongs = entries.some((entry) => entry.session?.id === sessionId && entry.session?.kind === "compact");
    results.push({
      turn: `summary to ${compaction.upToTurn}`,
      runId: compaction.runId,
      ok: report.valid === true && belongs,
      note: !report.valid ? report.text ?? "the receipt does not verify" : belongs ? "receipt verifies and names this summary" : "receipt verifies but does not name a summary of this session",
    });
  }
  return { sessionId, turns: results, valid: results.every((result) => result.ok) };
}

// Takes back the file changes of the newest turn that has not been taken back.
// Reports what it reverted and what it left, and why.
async function undoLastTurnUnlocked({ root, sessionId, now = () => new Date() }) {
  if (!sessionId) return { ok: false, message: "There is no conversation yet, so nothing to undo." };
  const { turns } = await readSession(root, sessionId);
  const turn = [...turns].reverse().find((entry) => entry.status === "succeeded" && !entry.undone);
  if (!turn) return { ok: false, message: "No turn is left to undo." };
  if (!turn.snapshots?.before) {
    return { ok: false, message: `Turn ${turn.turn} cannot be undone: no snapshot was taken (${turn.snapshots?.unavailable ?? "an older turn"}).` };
  }
  if (!Array.isArray(turn.fileEffects)) return { ok: false, message: `Turn ${turn.turn} has no attributed file journal; review its changes manually.` };
  const result = await undoFileEffects(root, turn.fileEffects);
  await appendTurn(root, sessionId, { type: "undo", turn: turn.turn, at: now().toISOString(), ...result });
  const lines = [];
  if (turn.fileEffects.length === 0) lines.push(`Turn ${turn.turn} changed no files, so there was nothing to take back.`);
  else lines.push(`Turn ${turn.turn}: ${result.reverted.length} file${result.reverted.length === 1 ? "" : "s"} put back${result.reverted.length ? ` (${result.reverted.join(", ")})` : ""}.`);
  for (const file of result.skipped) lines.push(`  left ${file.path}: ${file.reason}`);
  return { ok: true, turn: turn.turn, ...result, message: lines.join("\n") };
}

const SUMMARY_REQUEST = [
  "Summarise this conversation so far so that you can carry on from the summary alone.",
  "Say what the user wants, what has been decided, which files were read or changed and why,",
  "what is still open, and anything they asked you to remember. Plain prose, under 300 words.",
  "Do not use any tool and do not start new work; answer with the summary only.",
].join(" ");

// Replaces the model's memory of the older turns with a summary it wrote. The
// turns stay in the session file; what changes is what the next turn is told.
// The summary is itself a run - a receipt, a cost, an agent that may use no
// tool - and the session line names it, so a compacted conversation is one
// that says it was compacted and can be checked.
// Whether there is anything worth summarising, decided before a model is asked.
export async function compactionCheck(root, sessionId) {
  if (!sessionId) return { ok: false, message: "There is no conversation yet, so nothing to compact." };
  const prior = await readSession(root, sessionId);
  const covered = prior.compactions.at(-1)?.upToTurn ?? 0;
  const fresh = prior.turns.filter((turn) => turn.status === "succeeded" && turn.turn > covered);
  if (fresh.length < 2) {
    return { ok: false, message: "There are fewer than two new turns since the last summary; nothing worth compacting yet." };
  }
  return { ok: true, prior, covered, fresh };
}

async function compactSessionUnlocked({ root, sessionId, agent, runner, now = () => new Date(), ...runOptions } = /** @type {any} */ ({})) {
  const check = await compactionCheck(root, sessionId);
  if (!check.ok) return check;
  const { prior, covered, fresh } = check;
  await assertWithinBudget(root, prior, runOptions.env);
  const upToTurn = prior.turns.at(-1).turn;
  const run = runner ?? (await import("./project-runner.js")).runProject;
  const outcome = await run({
    root,
    input: SUMMARY_REQUEST,
    agent,
    worktree: false,
    ...runOptions,
    // May use no tool at all, by the harness and not by asking.
    agentOverride: { ...(runOptions.agentOverride ?? {}), tools: [] },
    session: { id: sessionId, turn: upToTurn, kind: "compact", history: boundHistory(historyFrom(prior.turns, prior.compactions)).history },
  });
  const summary = replyOf(outcome);
  if (outcome.status !== "succeeded" || typeof summary !== "string" || summary.trim() === "") {
    return { ok: false, message: `The summary was not written (the run ended ${outcome.status ?? "without an answer"}); the conversation is unchanged.` };
  }
  await appendTurn(root, sessionId, { type: "compact", at: now().toISOString(), upToTurn, turns: fresh.length, runId: outcome.runId, summary: summary.trim(), ...(usageOf(outcome) ? { usage: usageOf(outcome) } : {}) });
  return { ok: true, upToTurn, summary: summary.trim(), runId: outcome.runId, message: `Turns ${covered + 1}–${upToTurn} are now carried as a summary (${summary.trim().length} characters). The turns themselves are unchanged on disk.` };
}

export async function runChatTurn(options = {}) {
  const lease = options.workspaceLease ?? await acquireWorkspaceLease(options.root, { sessionId: options.sessionId });
  try { return await runChatTurnUnlocked({ ...options, workspaceLease: lease }); }
  finally { lease.release(); }
}

export async function undoLastTurn(options = {}) {
  const lease = options.workspaceLease ?? await acquireWorkspaceLease(options.root, { sessionId: options.sessionId });
  try { return await undoLastTurnUnlocked({ ...options, workspaceLease: lease }); }
  finally { lease.release(); }
}

export async function compactSession(options = {}) {
  const lease = options.workspaceLease ?? await acquireWorkspaceLease(options.root, { sessionId: options.sessionId });
  try { return await compactSessionUnlocked({ ...options, workspaceLease: lease }); }
  finally { lease.release(); }
}
