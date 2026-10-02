// @ts-check
import { readLines } from "./jsonl.js";
import { join, resolve } from "node:path";
import { loadReceiptVerifiers } from "../core/receipt-signing.js";
import { readdir, stat } from "node:fs/promises";
import { refreshPricing } from "../observability/pricing-sync.js";
import { summarizeTelemetryFile } from "../observability/telemetry.js";
import { swallow } from "./swallow.js";
import { verifyReceiptFile } from "../core/receipt-store.js";

// Reading receipts and describing them: what a run did, who approved what, whether
// it verifies. Pure reading; nothing here starts or changes a run.

// Runs are read from their receipt files, so every surface shows what was
// sealed rather than a summary kept somewhere else.
// A sealed receipt never changes again, and the surfaces read the last twenty
// of them on every poll — once a second in the terminal interface. One receipt
// of an eleven-second run in this repository is 68 KB; a real multi-step run
// with file contents in its tool results is a multiple of that, and the
// machine this runs on is a phone.
//
// So a receipt is parsed once and kept, keyed by what would have to change for
// the answer to differ: its size and its modification time. A receipt that is
// still being written fails that key on the next poll and is read again.
const receiptCache = new Map();

export async function countRuns(directory) {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((name) => name.endsWith(".jsonl")).length;
}

export async function readRuns(directory, { limit = 20, cache = receiptCache } = /** @type {any} */ ({})) {
  const entries = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((name) => name.endsWith(".jsonl")).sort().reverse().slice(0, limit);
  // Anything no longer in the window cannot be asked for again through here.
  const wanted = new Set(files.map((file) => join(directory, file)));
  for (const key of cache.keys()) if (!wanted.has(key)) cache.delete(key);
  const runs = [];
  for (const file of files) {
    const path = join(directory, file);
    const details = await stat(path).catch(() => undefined);
    const fingerprint = details ? `${details.size}:${details.mtimeMs}` : undefined;
    const hit = cache.get(path);
    if (hit && fingerprint !== undefined && hit.fingerprint === fingerprint) {
      runs.push(hit.run);
      continue;
    }
    // Streamed, because a receipt is as long as the run was. Only what the list
    // shows is kept: how many entries, the first mode, the last sealed record and
    // the approvals; a line is parsed when it can matter.
    let entryCount = 0;
    let firstMode;
    let sealed;
    let approvals = 0;
    let failure;
    try {
      for await (const line of readLines(path)) {
        if (line === "") continue;
        entryCount += 1;
        const sealing = line.includes('"terminal":true');
        const approving = line.includes('"approvals":[') && !line.includes('"approvals":[]');
        if (!sealing && !approving && firstMode !== undefined) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          // A malformed line is reported by 'etnpilot receipt verify'.
          continue;
        }
        if (firstMode === undefined && typeof entry.mode === "string") firstMode = entry.mode;
        if (entry.terminal === true) sealed = entry;
        if (approving) approvals += (entry.approvals ?? []).length;
      }
    } catch (error) {
      failure = error;
    }
    if (failure) {
      // A receipt that cannot be read is a row that says so, not a run that
      // is missing from the list.
      runs.push({ runId: file.replace(/\.jsonl$/, ""), status: "unreadable", mode: "execute", terminal: false, entries: 0, signed: false, approvals: 0, receiptFile: file, unreadable: failure.message });
      continue;
    }
    if (entryCount === 0) continue;
    const run = {
      // A receipt carries two kinds of id: each agent invocation writes its
      // own, and the workflow writes the run's. The run's is what every
      // surface names and what the file is called, so an unsealed receipt
      // takes it from the file rather than from the first agent that happened
      // to write a line.
      runId: sealed?.runId ?? file.replace(/\.jsonl$/, ""),
      status: sealed?.status ?? "incomplete",
      mode: sealed?.mode ?? firstMode ?? "execute",
      terminal: Boolean(sealed),
      entries: entryCount,
      hash: sealed?.hash,
      signed: Boolean(sealed?.proof),
      durationMs: sealed?.durationMs,
      branch: sealed?.workspace?.branch,
      sandbox: sealed?.workspace?.sandbox?.image,
      approvals,
      receiptFile: file,
    };
    // Only a sealed receipt is worth keeping: an unsealed one is still being
    // appended to, and its answer changes with the next line.
    if (fingerprint !== undefined && sealed) cache.set(path, { fingerprint, run });
    runs.push(run);
  }
  return runs;
}

// Why a run ended the way it did, from what the receipt already holds. Both
// surfaces ask this module rather than each reading the entries their own way,
// so neither can give a different answer about the same run.
export function describeOutcome(receipt, { running = false } = /** @type {any} */ ({})) {
  const terminal = receipt?.terminal ?? {};
  const summary = terminal.summary ?? {};
  const steps = Object.entries(summary.steps ?? {}).map(([id, step]) => ({ id, ...step }));
  const failed = steps.filter((step) => step.status === "failed");
  const blocked = steps.filter((step) => step.status === "blocked");
  const rejected = receipt?.entries?.flatMap((entry) => entry.approvals ?? [])
    .filter((approval) => approval.decision && approval.decision !== "approve-once") ?? [];
  const reasons = [];
  // The fatal error first: it is what actually stopped the run.
  if (summary.error) reasons.push({ kind: "error", text: summary.error });
  for (const step of failed) reasons.push({ kind: "step", step: step.id, text: step.error ?? "failed", attempts: step.attempts });
  for (const step of blocked) {
    reasons.push({
      kind: "blocked",
      step: step.id,
      text: step.reason === "dependency-failed"
        ? "never ran: a step it needs failed"
        : step.reason === "fail-fast"
          ? "never ran: the workflow stops at the first failure"
          : step.reason ?? "never ran",
    });
  }
  for (const approval of rejected) {
    reasons.push({
      kind: "approval",
      // What it was about and who or what said no: 'read was reject' named
      // neither, and five of them in a row could not be told apart.
      text: `${approval.subject || approval.operationKind || "an operation"} was ${approval.decision === "reject" ? "refused" : approval.decision}`
        + (approval.reason ?? approval.evidence?.reason ? `: ${approval.reason ?? approval.evidence.reason}` : "")
        + (approval.policy ? ` (policy: ${approval.policy.rule ? `rule '${approval.policy.rule}'` : "the section default"})` : ""),
    });
  }
  // What the run actually did with its tools. A run can be told to write a
  // file, have the write refused, and still end 'succeeded' because the model
  // finished its turn — the receipt records the refusal, so it is said here
  // rather than left for someone to notice by the file not being there.
  // Chat providers record 'toolCalls'; the scripted provider records the same
  // shape under 'steps', because its steps are the tools it ran.
  const toolCalls = receipt?.entries?.flatMap((entry) => entry.result?.toolCalls ?? entry.result?.steps ?? []) ?? [];
  // A refusal that went through an approval already appears above as that
  // approval; saying it twice is how five refusals became ten lines. One that
  // never reached an approval (a tool the agent may not use) appears only here.
  const told = new Set(rejected.map((approval) => approval.reason ?? approval.evidence?.reason).filter(Boolean));
  for (const call of toolCalls.filter((call) => call.ok === false && !(call.refused && told.has(call.error)))) {
    reasons.push({
      kind: "tool",
      text: `${call.label ?? call.tool ?? "a tool"} ${call.refused ? "was refused" : "failed"}: ${call.error ?? "no reason recorded"}`,
    });
  }
  if (terminal.content?.verificationError) {
    reasons.push({ kind: "content", text: `content verification: ${terminal.content.verificationError}` });
  }
  // Not published is not a failure, but it is the first thing a reviewer asks.
  const publication = terminal.publication;
  if (publication && publication.published === false) {
    reasons.push({ kind: "publication", text: publicationReason(publication) });
  }
  if (terminal.terminal !== true && terminal.status === undefined) {
    // A receipt with no terminal record looks the same while it is being
    // written and after it was abandoned. Saying 'the run stopped' about one
    // that is still going is the surface inventing what it cannot see: a run
    // that then seals turns that sentence into a plain falsehood.
    reasons.push(running
      ? { kind: "running", text: "the run is still going: its receipt is sealed when it ends" }
      : {
        kind: "incomplete",
        text: "the receipt has no terminal record: the run stopped before it could finish,"
          + " or it is still going somewhere this surface did not start it."
          + " A run started from the page or the terminal screen stops with the app: if it was closed"
          + " or the phone ended it in the background, start the task again. The work it did is in its"
          + " worktree (see Worktrees), which is kept until you remove it",
      });
  }
  return {
    // 'incomplete' rather than 'unknown': a receipt with no terminal record
    // is not a run whose outcome could not be read, it is a run that never
    // reported one.
    status: terminal.status ?? summary.status ?? (receipt?.terminal ? "unknown" : running ? "running" : "incomplete"),
    sealed: Boolean(receipt?.terminal),
    agents: agentTree(receipt),
    steps,
    reasons,
    usage: terminal.observability?.summary,
    // Where the work is. A run in a worktree leaves its files there and not in
    // the checkout, and 'BRANCH etnpilot/run-…' does not tell anyone where to
    // look for them.
    ...(terminal.workspace ? { workspace: terminal.workspace } : {}),
    ...(toolCalls.length > 0 ? { tools: summarizeToolCalls(toolCalls) } : {}),
    ...(terminal.git?.mergeRehearsal ? { rehearsal: describeRehearsal(terminal.git.mergeRehearsal) } : {}),
    ...(terminal.cleanup ? { cleanup: terminal.cleanup } : {}),
  };
}

// One row per tool, so 'it wrote three files and one was refused' is readable
// without counting lines.
function summarizeToolCalls(calls) {
  const byTool = new Map();
  for (const call of calls) {
    const name = call.tool ?? "unknown";
    const row = byTool.get(name) ?? { tool: name, ok: 0, failed: 0, refused: 0 };
    if (call.ok === false) {
      // Not allowed and did not work are different things: the first is a
      // decision somebody made, the second a fault.
      if (call.refused) row.refused += 1;
      else row.failed += 1;
      if (call.error && !row.error) row.error = call.error;
    } else row.ok += 1;
    byTool.set(name, row);
  }
  return [...byTool.values()];
}

const REHEARSAL_REASONS = Object.freeze({
  "fetch-failed": "the target branch could not be fetched",
  "merge-tree-unavailable": "this git does not support 'merge-tree --write-tree'",
});

// A merge that was never attempted is not a merge that is not clean. The
// rehearsal fetches the target branch first, and a fetch that fails leaves
// nothing to be clean or dirty about — reporting that as 'not clean' invents
// a conflict nobody found.
function describeRehearsal(rehearsal) {
  const target = rehearsal.targetBranch ?? "the target branch";
  if (rehearsal.rehearsed === false) {
    const why = REHEARSAL_REASONS[rehearsal.reason] ?? rehearsal.reason ?? "no reason recorded";
    return {
      state: "not-rehearsed",
      text: `not rehearsed against ${target}: ${why}`,
      ...(rehearsal.error ? { error: rehearsal.error } : {}),
    };
  }
  if (rehearsal.clean === true) return { state: "clean", text: `clean into ${target}` };
  const conflicts = rehearsal.conflicts ?? [];
  return conflicts.length > 0
    ? { state: "conflicts", text: `conflicts with ${target}: ${conflicts.join(", ")}`, conflicts }
    : { state: "conflicts", text: `does not merge into ${target}, with no file named`, conflicts };
}

// The agents that ran, as the tree they actually ran in rather than a flat
// list of lines: each invocation's own runId and parentRunId are what link a
// subagent call to the agent that spawned it. Every surface reads this tree
// instead of the raw entries, so a run opened on the phone and one read from
// the terminal show the same shape.
//
// Today every built-in provider is flat — none call the 'spawn' a manifest's
// 'subagents' declares — so this renders as one row per workflow step. It
// nests correctly the day one does, without either surface changing.
function agentTree(receipt) {
  const entries = (receipt?.entries ?? [])
    .filter((entry) => typeof entry.agent === "string" && typeof entry.runId === "string");
  const byId = new Map(entries.map((entry) => [entry.runId, agentNode(entry)]));
  const roots = [];
  for (const entry of entries) {
    const node = byId.get(entry.runId);
    const parent = entry.parentRunId ? byId.get(entry.parentRunId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function agentNode(entry) {
  const result = entry.result ?? {};
  // The scripted provider records its steps under 'steps' rather than
  // 'toolCalls' — the same shape under another name, read the same way here
  // as it already is for 'Tools it used'.
  const toolCalls = result.toolCalls ?? result.steps ?? [];
  return {
    runId: entry.runId,
    agent: entry.agent,
    ...(entry.workflowStep ? { workflowStep: entry.workflowStep } : {}),
    provider: entry.provider,
    status: entry.status ?? "unknown",
    durationMs: entry.durationMs,
    // The full text, untruncated: it is already what the receipt holds, and
    // reading it back is the point of showing this at all.
    text: result.text ?? "",
    toolCalls,
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    approvals: entry.approvals?.length ?? 0,
    children: [],
  };
}

// What the provider actually sent back, per agent invocation, exactly as it
// arrived — 'raw' is what each provider's invoke() already returns and the
// receipt already stores; this only reads it back rather than adding a new
// place to look. Kept out of agentTree(): the page and the terminal render
// that tree on every screen a run has, and a full API payload does not
// belong on a phone by default. This is for the one command that asks for it.
export function agentRawResponses(receipt) {
  return (receipt?.entries ?? [])
    .filter((entry) => typeof entry.agent === "string" && entry.result?.raw !== undefined)
    .map((entry) => ({
      runId: entry.runId,
      agent: entry.agent,
      ...(entry.workflowStep ? { workflowStep: entry.workflowStep } : {}),
      ...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
      provider: entry.provider,
      model: entry.result.raw?.model ?? entry.result.model,
      raw: entry.result.raw,
    }));
}

function publicationReason(publication) {
  if (publication.reason === "workflow-not-succeeded") return "not published: the workflow did not succeed";
  if (publication.reason === "merge-conflict") {
    return `not published: it would conflict with ${(publication.conflicts ?? []).join(", ") || "the target branch"}`;
  }
  return `not published: ${publication.reason ?? "no reason recorded"}`;
}

// Verifying is a different question from reading: the chain and the signature,
// rather than what the run did. A receipt whose chain is broken still reads —
// that is exactly why this answer has to be available next to it.
export async function verifyProjectReceipt(directory, file, { root, config } = /** @type {any} */ ({})) {
  assertReceiptName(file);
  const configured = config?.receipts?.signing?.publicKeyFile;
  const verifiers = configured
    ? await loadReceiptVerifiers([resolve(root, configured)], { windows: config?.receipts?.signing?.keyWindows }).catch(swallow("receipt verifier keys", undefined))
    : undefined;
  const report = await verifyReceiptFile(join(directory, file), { ...(verifiers ? { verifiers } : {}) });
  return {
    file,
    ...report,
    // Which question was actually asked: with no public key configured the
    // chain is checked and the signatures are not, and a surface that says
    // 'verified' either way would be claiming the stronger of the two.
    signaturesChecked: Boolean(verifiers),
    ...describeVerification(report, { signaturesChecked: Boolean(verifiers) }),
  };
}

// A reason code is for a program; this is the sentence a person reads. Every
// failure here means someone or something changed a sealed record, so it says
// which line and what kind of change it was, not 'invalid'.
function describeVerification(report, { signaturesChecked = false } = /** @type {any} */ ({})) {
  if (report.valid) {
    const chain = `${report.entries} ${report.entries === 1 ? "entry" : "entries"}, each hashed onto the one before it`;
    const signatures = signaturesChecked
      ? report.signed === 0
        ? "nothing is signed"
        : `${report.signed} signed${report.unsigned > 0 ? `, ${report.unsigned} not` : ""}`
      : "signatures were not checked: no public key is configured";
    return {
      tone: signaturesChecked && report.unsigned === 0 && report.signed > 0 ? "ok" : "warn",
      text: `The chain holds: ${chain}. ${signatures[0].toUpperCase()}${signatures.slice(1)}.`
        + (report.encoding === "mixed" ? " Some entries predate canonical hashing and were checked the old way." : ""),
    };
  }
  const at = report.line === undefined ? "" : ` at line ${report.line}`;
  const reasons = {
    "file-read-failed": "The receipt could not be read.",
    "empty-file": "The receipt file is empty; nothing was ever written to it.",
    "invalid-json": `The receipt is not readable${at}: that line is not valid JSON.`,
    "invalid-entry": `The receipt is not readable${at}: that line is not a receipt entry.`,
    "hash-mismatch": `An entry does not match its own hash${at}: it was changed after it was written.`,
    "chain-mismatch": `An entry does not follow the one before it${at}: an entry was inserted, removed or reordered.`,
    "entries-after-terminal": `Something was appended after the run had already ended${at}.`,
    "signature-required": `An entry${at} carries no signature, and this project requires one.`,
    "untrusted-key": `An entry${at} is signed with a key this project does not trust${report.keyId ? ` (${report.keyId})` : ""}.`,
    "invalid-signature": `A signature does not match its entry${at}: the entry or the signature was changed.`,
    "key-not-yet-valid": `An entry${at} was signed before its key was valid.`,
    "key-expired": `An entry${at} was signed after its key's validity ended.`,
    "key-revoked": `An entry${at} was signed after its key was revoked.`,
    "undated-entry": `An entry${at} carries no signing time, and dated entries were required.`,
    "unsupported-proof": `An entry${at} carries a kind of proof this version cannot check.`,
    "terminal-receipt-required": "The receipt was never sealed: the run did not record an end.",
  };
  return {
    tone: "bad",
    text: reasons[report.reason] ?? `The receipt did not verify${at}: ${report.reason}.`,
  };
}

function assertReceiptName(file) {
  if (typeof file !== "string" || file.includes("/") || file.includes("\\") || !file.endsWith(".jsonl")) {
    throw new TypeError(`'${file}' is not a receipt file in this project.`);
  }
}

// The sealed receipt holds the cost as it was worked out during the run, and
// must not change. When that was 'no rate' for a model the table of published
// prices knows, the run's usage is read back from the telemetry file, which
// prices it now; the receipt itself stays exactly as sealed.
export async function withCurrentPricing(receipt, { root, config, runId }) {
  const usage = receipt.outcome?.usage;
  if (!usage || !(usage.unpricedInvocations > 0) || usage.estimatedCost !== undefined) return receipt;
  await refreshPricing({ root, config }).catch(swallow("price refresh", undefined));
  const file = resolve(root, config?.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
  const fresh = await summarizeTelemetryFile(file, { workflowRunId: receipt.terminal?.runId ?? runId, root, config }).catch(swallow("telemetry summary of a run", undefined));
  if (!fresh || fresh.estimatedCost === undefined) return receipt;
  const merged = { ...usage, ...fresh, retrospective: true };
  if (!fresh.unpricedModels) delete merged.unpricedModels;
  return { ...receipt, outcome: { ...receipt.outcome, usage: merged } };
}

// A run's receipt in full, for its detail view. The file as a whole is limited to
// 64 MiB, because here every entry is held; listing and verifying are not limited
// that way (see readRuns and verifyReceiptFile). A run past the limit says so and
// points at the command that does not need to hold it.
const DETAIL_LIMIT_BYTES = 64 * 1024 * 1024;

export async function readReceipt(directory, file) {
  assertReceiptName(file);
  const path = join(directory, file);
  const size = (await stat(path)).size;
  if (size > DETAIL_LIMIT_BYTES) {
    throw Object.assign(new Error(`This receipt is ${Math.round(size / 1024 / 1024)} MiB, more than the ${DETAIL_LIMIT_BYTES / 1024 / 1024} MiB the detail view holds. 'etnpilot receipt verify ${file}' checks it without loading it.`), { statusCode: 413 });
  }
  const entries = [];
  for await (const line of readLines(path)) {
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ malformed: true });
    }
  }
  const receipt = { file, entries, terminal: entries.findLast((entry) => entry.terminal === true) };
  return { ...receipt, outcome: describeOutcome(receipt) };
}

// The worktrees this repository has, with ETNPilot's own marked and the
// branches they hold. A run works in one of these, so what is on disk is part
// of the same evidence as the receipt it wrote.
// A unified diff, read as the lines it touches: every line carries the number
// it has on each side, so a surface can show where a change is rather than
// only what it says.
export function parseDiff(text, { limit = 2000 } = /** @type {any} */ ({})) {
  const lines = [];
  let oldLine = 0;
  let newLine = 0;
  let hunks = 0;
  let added = 0;
  let deleted = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (lines.length >= limit) return { lines, hunks, added, deleted, cut: true };
    if (line.startsWith("diff --git") || line.startsWith("index ")
      || line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("new file") || line.startsWith("deleted file")
      || line.startsWith("similarity index") || line.startsWith("rename ")
      || line.startsWith("old mode") || line.startsWith("new mode")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunks += 1;
      lines.push({ kind: "hunk", text: line, context: hunk[3].trim() });
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      lines.push({ kind: "note", text: line.slice(2) });
      continue;
    }
    if (hunks === 0) continue;
    if (line.startsWith("+")) {
      added += 1;
      lines.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      deleted += 1;
      lines.push({ kind: "remove", text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  // A diff that ends with a blank line is the split's doing, not the file's.
  while (lines.at(-1)?.kind === "context" && lines.at(-1).text === "") lines.pop();
  return { lines, hunks, added, deleted };
}

