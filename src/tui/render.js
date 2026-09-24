import { createStyle, displayWidth, duration, pad, padStart, shortId, since, truncate, until } from "./ansi.js";

// Every view is a pure function of state and viewport: state in, lines out.
// The runtime below only paints what these return, which is what makes the
// interface testable without a terminal.

const VIEWS = Object.freeze(["approvals", "runs", "queue", "settings", "worktrees", "merges", "checks"]);

export function viewList() {
  return [...VIEWS];
}

export function renderApp(state, options = {}) {
  const {
    view = "approvals",
    cursor = 0,
    detail = false,
    width = 100,
    height = 30,
    now = Date.now(),
    color = true,
    message,
    project = "",
    editor,
    filter = "",
    filtering = false,
    scope = "local",
    prompt,
    help = false,
    helpOffset = 0,
    receipt,
    worktrees,
    merges,
    active = [],
  } = options;
  const worktreeDiffOpen = Boolean(options.worktreeDiff);
  const agentTextOpen = Boolean(options.agentText);
  const style = createStyle({ color });
  // Typing happens on the bottom line, the way a terminal tool has always done
  // it, so whatever you were looking at stays on screen while you type.
  const input = inputState({ prompt, editor, filtering, filter });
  const body = height - (input ? 4 : 3);
  const lines = [
    header(state, { style, width, view, project, active }),
    "",
  ];

  const context = {
    style, width, height: body, cursor, now, editor, filter, filtering, scope, receipt,
    worktrees, changes: options.worktreeChanges, changeCursor: options.changeCursor, merges, active,
    agentMode: options.agentMode, agentCursor: options.agentCursor,
    checks: options.checks ?? [], results: options.checkResults ?? {}, running: options.checksRunning ?? new Set(),
    verification: options.verification,
  };
  const rendered = help
    ? renderHelp({ style, width, height: body, offset: helpOffset })
    : detail && view === "approvals"
      ? renderApprovalDetail(state, context)
      : detail && view === "runs"
        ? (agentTextOpen
            ? renderAgentText(state, { ...context, agentText: options.agentText, offset: options.agentTextOffset })
            : renderRunDetail(state, context))
        : detail && view === "worktrees"
          ? (options.worktreeDiff
              ? renderDiff(state, { ...context, diff: options.worktreeDiff, offset: options.diffOffset })
              : renderWorktreeChanges(state, context))
          : renderView(view, state, context);
  for (const line of rendered.slice(0, body)) lines.push(truncate(line, width));
  while (lines.length < height - (input ? 2 : 1)) lines.push("");
  if (input) {
    lines.push(truncate(input.bad ? style.bad(input.hint) : style.dim(input.hint), width));
    lines.push(inputLine(input, { style, width }));
  } else {
    lines.push(footer({
      style, width, view, detail, message, editor, prompt, help, diff: worktreeDiffOpen,
      agentMode: options.agentMode, agentText: agentTextOpen,
    }));
  }
  return lines.slice(0, height).map((line) => truncate(line, width));
}

function renderView(view, state, context) {
  if (view === "runs") return renderRuns(state, context);
  if (view === "checks") return renderChecks(state, context);
  if (view === "queue") return renderQueue(state, context);
  if (view === "worktrees") return renderWorktrees(state, context);
  if (view === "merges") return renderMerges(state, context);
  if (view === "settings") {
    return renderSettings(state, context);
  }
  return renderApprovals(state, context);
}

function header(state, { style, width, view, project, active = [] }) {
  const pending = state.approvals?.pending?.length ?? 0;
  const counts = state.queue?.counts ?? {};
  // Runs this window started count too, or a run you are watching would not
  // appear in the one place that claims to say how many are running.
  const running = (counts.running ?? 0) + active.length;
  const label = (name) => (name === "approvals" && pending > 0 ? `${name} ${pending}` : name);
  const tabs = VIEWS.map((name) => (name === view
    ? style.bold(style.accent(label(name)))
    : style.dim(label(name)))).join(style.dim("  ·  "));
  const brand = style.bold(style.accent("ETNPILOT"));
  // A phone terminal is 40 to 60 columns, and seven tabs do not fit there:
  // the strip was cut mid-word, which loses both the tabs it dropped and the
  // count on the right. Below that width the header names the view you are on
  // and its number, which is what the keys 1-7 need anyway.
  const plain = `ETNPILOT  ${VIEWS.map(label).join("  ·  ")}`;
  const compact = `${label(view)} ${VIEWS.indexOf(view) + 1}/${VIEWS.length}`;
  const left = plain.length + 12 <= width
    ? `${brand}  ${tabs}`
    : `${brand}  ${style.bold(style.accent(compact))}`;
  const working = active.find((run) => run.step);
  const where = working ? ` ${working.step}${working.stepAgent ? `/${working.stepAgent}` : ""}` : "";
  // How many runs are going is the fact this line exists for; the project name
  // is context. Where the tabs leave room for only one of them, the count
  // stays — a seventh tab was enough to push it off the right at 100 columns,
  // and 'varga.pter9…' in its place says nothing at all.
  const count = `${running} running${where}`;
  const full = `${project}${project ? "  " : ""}${count}`;
  const room = width - displayWidth(left) - 1;
  const text = displayWidth(full) <= room ? full : count;
  const right = style.dim(text);
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(text));
  return left + " ".repeat(gap) + right;
}

function footer({ style, width, view, detail, message, editor, prompt, help, ...options }) {
  if (message) return truncate(style.warn(message), width);
  const keys = footerKeys({ view, detail, editor, prompt, help, diff: options.diff, agentMode: options.agentMode, agentText: options.agentText });
  return truncate(keys.map(([key, label]) => `${style.accent(key)} ${style.dim(label)}`).join(style.dim("  ")), width);
}

// Whatever is on screen decides which keys the footer promises. A key it names
// has to do something here, or the footer is teaching the wrong thing.
function footerKeys({ view, detail, editor, prompt, help, diff, agentMode, agentText }) {
  if (help) return [["↑↓", "scroll"], ["?", "close"], ["esc", "close"], ["q", "quit"]];
  if (prompt) return [["enter", "start"], ["tab", "agent"], ["esc", "cancel"], ["^u", "clear"]];
  if (editor) {
    return editor.entry.choices?.kind === "one"
      ? [["← →", "choose"], ["enter", "save"], ["esc", "cancel"]]
      : [["enter", "save"], ["esc", "cancel"], ["^u", "clear"]];
  }
  if (agentText && view === "runs") return [["↑↓", "scroll"], ["esc", "back"], ["q", "quit"]];
  if (agentMode && view === "runs") return [["↑↓", "move"], ["enter", "read"], ["esc", "back"], ["q", "quit"]];
  if (detail && view === "runs") return [["a", "agents"], ["v", "verify"], ["esc", "back"], ["n", "run"], ["q", "quit"]];
  if (diff && view === "worktrees") return [["↑↓", "scroll"], ["esc", "back"], ["q", "quit"]];
  if (detail && view === "worktrees") {
    return [["↑↓", "move"], ["enter", "what changed"], ["esc", "back"], ["x", "remove if clean"], ["q", "quit"]];
  }
  if (detail) return [["a", "approve"], ["r", "reject"], ["esc", "back"], ["q", "quit"]];
  if (view === "approvals") {
    return [["↑↓", "move"], ["enter", "open"], ["a", "approve"], ["r", "reject"], ["n", "run"], ["tab", "view"], ["q", "quit"]];
  }
  if (view === "queue") {
    return [["↑↓", "move"], ["c", "cancel"], ["R", "resume"], ["n", "run"], ["tab", "view"], ["q", "quit"]];
  }
  if (view === "worktrees") {
    return [["↑↓", "move"], ["enter", "what it holds"], ["x", "remove if clean"], ["g", "reread"], ["tab", "view"], ["q", "quit"]];
  }
  if (view === "merges") {
    return [["↑↓", "move"], ["g", "reread"], ["n", "run"], ["tab", "view"], ["?", "help"], ["q", "quit"]];
  }
  if (view === "checks") {
    return [["↑↓", "move"], ["enter", "run it"], ["A", "run all"], ["tab", "view"], ["?", "help"], ["q", "quit"]];
  }
  if (view === "settings") {
    return [["↑↓", "move"], ["enter", "edit"], ["d", "default"], ["s", "scope"], ["/", "filter"], ["tab", "view"], ["q", "quit"]];
  }
  return [["↑↓", "move"], ["enter", "open"], ["n", "run"], ["tab", "view"], ["?", "help"], ["q", "quit"]];
}

function renderApprovals(state, { style, width, height, cursor, now }) {
  const pending = state.approvals?.pending ?? [];
  if (pending.length === 0) {
    return [style.dim("Nothing is waiting for a decision."), "", style.dim("Runs continue until one of them needs you.")];
  }
  const lines = [style.dim(`${pending.length} waiting · oldest ${since(pending.at(-1).createdAt, now)}`), ""];
  const rows = Math.max(1, Math.floor((height - 2) / 3));
  for (const [index, approval] of window(pending, cursor, rows).entries()) {
    const selected = pending.indexOf(approval) === clamp(cursor, pending.length);
    const marker = selected ? style.accent("›") : " ";
    const kind = kindLabel(approval.operationKind, style);
    const origin = style.dim(`${approval.agent ?? "unknown"} · ${shortId(approval.runId, { kind: "run" })}`);
    const age = style.dim(since(approval.createdAt, now));
    const head = `${marker} ${kind} ${origin}`;
    lines.push(pad(head, width - displayWidth(age) - 1) + age);
    lines.push(`   ${selected ? style.ink(subject(approval)) : style.dim(subject(approval))}`);
    if (index < rows - 1) lines.push("");
  }
  return lines;
}

function renderApprovalDetail(state, { style, width, height, cursor }) {
  const pending = state.approvals?.pending ?? [];
  const approval = pending[clamp(cursor, pending.length)];
  if (!approval) return [style.dim("That approval is gone — it was decided elsewhere.")];
  const details = approval.details ?? {};
  const lines = [
    `${kindLabel(approval.operationKind, style)} ${style.dim(`${approval.agent ?? "unknown"} · run ${approval.runId ?? "—"}`)}`,
    "",
  ];
  const field = (label, value) => {
    if (!value) return;
    lines.push(style.dim(label));
    for (const piece of wrap(String(value), width - 2)) lines.push(`  ${style.ink(piece)}`);
    lines.push("");
  };
  field("Command", details.command);
  field("File", details.file);
  field("URL", details.url);
  field("Tool", details.tool);
  field("Arguments", details.arguments);
  if (details.truncated) lines.push(style.warn("Shown up to the display limit; the full text is in the receipt."), "");
  if (approval.policy) {
    lines.push(style.dim("Why you are being asked"));
    const effect = approval.policy.effect ?? "human";
    const tone = effect === "deny" ? "bad" : effect === "allow" ? "ok" : "warn";
    const rule = approval.policy.rule ? `rule '${approval.policy.rule}'` : "the section default";
    lines.push(`  ${style.tone(effect, tone)} ${style.muted(`← ${rule}`)}`, "");
  }
  lines.push(style.dim("Fingerprint"), `  ${style.muted(details.fingerprint ?? "—")}`, "");
  lines.push(style.dim(`Expires in ${until(approval.expiresAt)}`));
  return lines.slice(0, height);
}

function renderRuns(state, { style, width, height, cursor, now }) {
  const runs = state.runs ?? [];
  if (runs.length === 0) return [style.dim("No runs have been recorded yet.")];
  const columns = [
    { label: "RUN", width: 26, value: (run) => run.runId },
    { label: "STATUS", width: 14, value: (run) => run.status, tone: (run) => statusTone(run.status) },
    { label: "MODE", width: 9, value: (run) => run.mode },
    { label: "SEALED", width: 7, value: (run) => (run.terminal ? "yes" : "no"), tone: (run) => (run.terminal ? "ok" : "warn") },
    { label: "SIGNED", width: 7, value: (run) => (run.signed ? "yes" : "no") },
    { label: "APPR", width: 5, value: (run) => String(run.approvals ?? 0) },
    { label: "TOOK", width: 9, value: (run) => duration(run.durationMs) },
  ];
  return table(runs, columns, { style, width, height, cursor, now });
}

function renderQueue(state, { style, width, height, cursor, now }) {
  const jobs = state.queue?.jobs ?? [];
  const counts = state.queue?.counts ?? {};
  const summary = Object.entries(counts).map(([status, total]) => `${status} ${total}`).join(" · ");
  if (jobs.length === 0) return [style.dim(summary || "The queue is empty.")];
  const columns = [
    { label: "JOB", width: 12, value: (job) => shortId(job.id) },
    { label: "KIND", width: 16, value: (job) => job.kind },
    { label: "STATUS", width: 18, value: (job) => job.status, tone: (job) => queueTone(job.status) },
    { label: "TRIES", width: 6, value: (job) => String(job.attempts ?? 0) },
    { label: "UPDATED", width: 10, value: (job) => since(job.updatedAt, now) },
  ];
  return [style.dim(summary), "", ...table(jobs, columns, { style, width, height: height - 2, cursor, now })];
}

// The worktrees on disk: which branch each holds, which ones a run made, and
// whether removing one would throw away work. A worktree is where a run's
// changes physically are, so it is evidence as much as the receipt is.
// The files a worktree is holding: a number is a claim, the list is the
// evidence, and it is what removing the worktree would throw away.
export function renderWorktreeChanges(state, { style, width, height, cursor, worktrees, changes, changeCursor = 0 }) {
  const entries = worktrees?.entries ?? [];
  const entry = entries[clamp(cursor, entries.length)];
  if (!entry) return [style.dim("No worktrees are registered.")];
  const lines = [
    `${style.bold(style.ink(entry.name))} ${style.muted(entry.branch ?? "")}`,
    "",
  ];
  if (!changes || changes.name !== entry.name) return [...lines, style.dim("Reading what it holds…")];
  if (changes.unreadable) {
    return [...lines, style.bad("Its directory cannot be read; 'git worktree prune' clears it.")];
  }
  if (changes.entries.length === 0) {
    return [...lines, style.ok("Nothing changed here. Removing it throws nothing away.")];
  }
  const room = Math.max(1, height - lines.length - 3);
  const selected = clamp(changeCursor, changes.entries.length);
  for (const change of window(changes.entries, changeCursor, room)) {
    const name = change.renamedFrom ? `${change.renamedFrom} → ${change.path}` : change.path;
    const marker = changes.entries.indexOf(change) === selected ? style.accent("›") : " ";
    lines.push(`${marker} ${style.tone(pad(change.label, 12), change.ignorable ? "muted" : "warn")} `
      + `${padStart(countLabel(change, style), 12)} ${style.ink(truncate(name, width - 30))}`);
  }
  if (changes.entries.length > room) {
    lines.push(style.dim(`  … ${changes.entries.length - room} more`));
  }
  lines.push("", changes.blocking === 0
    ? style.ok("None of this is a person's work, so this worktree can be removed.")
    : style.warn(`${changes.blocking} unsaved; removing is refused while they are here.`));
  return lines;
}

// How much changed, not only that something did.
function countLabel(change, style) {
  if (change.binary) return style.muted("binary");
  if (change.large) return style.muted("large");
  if (change.directory) return style.muted("dir");
  if (change.added === undefined && change.deleted === undefined) return style.muted("—");
  const added = change.added ? style.ok(`+${change.added}`) : "";
  const deleted = change.deleted ? style.bad(`−${change.deleted}`) : "";
  return `${added}${added && deleted ? " " : ""}${deleted}` || style.muted("0");
}

// One file's diff, with the number each line has on its own side.
export function renderDiff(state, { style, width, height, diff, offset = 0 }) {
  if (!diff) return [style.dim("Reading the diff…")];
  const head = [
    `${style.bold(style.ink(diff.file))} ${style.muted(diff.reason
      ? diff.reason
      : `+${diff.added ?? 0} −${diff.deleted ?? 0} in ${diff.hunks ?? 0} ${diff.hunks === 1 ? "place" : "places"}`)}`,
    "",
  ];
  if (diff.reason) return [...head, style.dim(`No diff: this file is ${diff.reason}.`)];
  if ((diff.lines ?? []).length === 0) return [...head, style.dim("git reports no textual change for this file.")];
  const room = Math.max(1, height - head.length - 1);
  const start = Math.min(Math.max(0, offset), Math.max(0, diff.lines.length - room));
  const body = diff.lines.slice(start, start + room).map((line) => {
    const numbers = `${padStart(line.oldLine === undefined ? "" : String(line.oldLine), 5)} `
      + `${padStart(line.newLine === undefined ? "" : String(line.newLine), 5)} `;
    if (line.kind === "hunk") return style.dim(truncate(`${" ".repeat(12)}${line.text}`, width));
    const mark = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
    const text = truncate(`${mark}${line.text}`, Math.max(8, width - 13));
    const tone = line.kind === "add" ? "ok" : line.kind === "remove" ? "bad" : "muted";
    return `${style.dim(numbers)}${style.tone(text, tone)}`;
  });
  const hidden = diff.lines.length - start - body.length;
  const footer = hidden > 0
    ? style.dim(`↑↓ scroll · ${hidden} more lines`)
    : style.dim(diff.cut || diff.truncated ? "cut here; read the rest with 'git diff'" : "the end");
  return [...head, ...body, footer];
}

// One agent's full reasoning, exactly as the receipt holds it — the same
// text the page shows when a row is opened there. Scrolls like the diff
// viewer, because it is read the same way: too long to fit, so a footer says
// how much more there is rather than cutting it silently.
export function renderAgentText(state, { style, width, height, agentText, offset = 0 }) {
  if (!agentText) return [style.dim("Reading…")];
  const label = (agentText.workflowStep ? `${agentText.workflowStep} · ` : "") + agentText.agent;
  const head = [
    `${style.bold(style.ink(label))} ${style.tone(agentText.status, statusTone(agentText.status))} `
      + style.muted(`${agentText.provider ?? "—"} · ${duration(agentText.durationMs)}`),
    "",
  ];
  const lines = [];
  const text = agentText.text || (agentText.error ? "" : "It produced no text.");
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") { lines.push(""); continue; }
    for (const piece of wrap(paragraph, width - 2)) lines.push(style.ink(piece));
  }
  if (agentText.error) {
    lines.push("", style.dim("Error"));
    for (const piece of wrap(agentText.error, width - 2)) lines.push(style.bad(piece));
  }
  if (agentText.toolCalls?.length > 0) {
    lines.push("", style.dim("Tool calls"));
    for (const call of agentText.toolCalls) {
      const tone = call.ok === false ? "bad" : "ok";
      lines.push(`  ${style.tone(pad(call.ok === false ? "refused" : "ran", 8), tone)} ${style.ink(pad(call.tool ?? "—", 14))} ${style.muted(call.error ?? "")}`);
    }
  }
  if (agentText.usage) {
    const usage = agentText.usage;
    lines.push("", style.dim("Usage"));
    lines.push(`  ${style.ink(`${(usage.inputTokens ?? 0).toLocaleString()} in · ${(usage.outputTokens ?? 0).toLocaleString()} out`)}`);
  }
  const room = Math.max(1, height - head.length - 1);
  const start = Math.min(Math.max(0, offset), Math.max(0, lines.length - room));
  const body = lines.slice(start, start + room);
  const hidden = lines.length - start - body.length;
  const bottom = hidden > 0 ? style.dim(`↑↓ scroll · ${hidden} more lines`) : style.dim("the end");
  return [...head, ...body, bottom];
}

// The checks this project can run on itself — the same ones the CLI has as
// subcommands, in a list, because a check nobody remembers the name of is a
// check nobody runs. Nothing here runs by itself: each row says when it last
// ran, or that it has not.
export function renderChecks(state, { style, width, height, cursor, checks = [], results = {}, running = new Set(), now }) {
  if (checks.length === 0) return [style.dim("No checks are registered.")];
  const ran = checks.filter((check) => results[check.id]).length;
  const failed = checks.filter((check) => results[check.id]?.ok === false).length;
  const summary = [
    `${checks.length} checks`,
    ran === 0 ? "none run yet" : `${ran} run`,
    failed > 0 ? `${failed} failing` : ran > 0 ? "none failing" : "nothing to report",
  ].join(" · ");
  const columns = [
    { label: "CHECK", width: Math.max(18, Math.floor(width * 0.22)), value: (check) => check.title },
    { label: "RESULT", width: 12, value: (check) => checkState(check, results, running),
      tone: (check) => checkTone(check, results, running) },
    { label: "WHAT IT FOUND", width: Math.max(24, Math.floor(width * 0.42)),
      value: (check) => results[check.id]?.summary ?? check.about },
    { label: "RAN", width: 9, value: (check) => (results[check.id] ? since(results[check.id].ranAt, now) : "—") },
  ];
  const lines = [style.dim(summary), "", ...table(checks, columns, { style, width, height: height - 2, cursor })];
  const selected = checks[clamp(cursor, checks.length)];
  const result = selected ? results[selected.id] : undefined;
  if (result) {
    lines.push("", ...renderCheckFindings(result, { style, width, height: Math.max(3, height - lines.length - 1) }));
  } else if (selected) {
    lines.push("", style.dim(`enter runs '${selected.title}'. Nothing here runs on its own.`));
  }
  return lines;
}

// What a check found, under the list. A check with nothing to say says that,
// rather than leaving the panel to be read as 'not run yet'.
function renderCheckFindings(result, { style, width, height }) {
  const head = result.ok === false
    ? style.bad(`${result.title}: ${result.summary}`)
    : result.ok === true
      ? style.ok(`${result.title}: ${result.summary}`)
      : style.warn(`${result.title}: ${result.summary}`);
  const lines = [head];
  const findings = result.findings ?? [];
  if (findings.length === 0) {
    lines.push(style.dim(result.ok === true ? "Nothing to look at." : "It reported no individual findings."));
    return lines.slice(0, height);
  }
  const room = Math.max(1, height - 2);
  for (const finding of findings.slice(0, room)) {
    const label = finding.label ? `${style.tone(pad(truncate(finding.label, 18), 18), finding.tone ?? "muted")} ` : "";
    lines.push(`  ${label}${style.ink(truncate(finding.text, Math.max(10, width - 24)))}`);
  }
  if (findings.length > room) lines.push(style.dim(`  … ${findings.length - room} more`));
  return lines.slice(0, height);
}

function checkState(check, results, running) {
  if (running.has(check.id)) return "running…";
  const result = results[check.id];
  if (!result) return "not run";
  if (result.ok === true) return "ok";
  if (result.ok === false) return "findings";
  return "no verdict";
}

function checkTone(check, results, running) {
  if (running.has(check.id)) return "warn";
  const result = results[check.id];
  if (!result) return "muted";
  if (result.ok === true) return "ok";
  if (result.ok === false) return "bad";
  return "warn";
}

export function renderWorktrees(state, { style, width, height, cursor, worktrees }) {
  if (worktrees === undefined) return [style.dim("Reading the worktrees…")];
  if (worktrees.available === false) {
    return [
      style.bad("The worktrees could not be listed."),
      "",
      ...wrap(worktrees.error ?? "git did not answer.", width - 2).map((line) => `  ${style.ink(line)}`),
      "",
      style.dim("A project outside a git checkout has none; 'etnpilot run' needs one."),
    ];
  }
  const entries = worktrees.entries ?? [];
  if (entries.length === 0) return [style.dim("No worktrees are registered.")];
  const summary = [
    `${entries.length} ${entries.length === 1 ? "worktree" : "worktrees"}`,
    `${worktrees.managed ?? 0} from runs`,
    worktrees.unsaved > 0 ? `${worktrees.unsaved} with unsaved work` : "nothing unsaved",
  ].join(" · ");
  const columns = [
    { label: "WORKTREE", width: Math.max(16, Math.floor(width * 0.24)), value: (entry) => entry.name },
    { label: "BRANCH", width: Math.max(18, Math.floor(width * 0.28)), value: (entry) => branchLabel(entry) },
    { label: "HEAD", width: 9, value: (entry) => (entry.head ?? "").slice(0, 8) },
    { label: "FROM", width: 9, value: (entry) => (entry.main ? "checkout" : entry.managed ? "a run" : "elsewhere"),
      tone: (entry) => (entry.managed ? "accent" : "muted") },
    { label: "STATE", width: 14, value: (entry) => worktreeState(entry), tone: (entry) => worktreeTone(entry) },
  ];
  const lines = [style.dim(summary), "", ...table(entries, columns, { style, width, height: height - 2, cursor })];
  // 'x' is in the footer, so the list says which rows it can actually act on
  // rather than letting the key look broken on the others.
  if (!entries.some((entry) => entry.removable)) {
    lines.push("", style.dim("None of these can be removed from here: only a run's own worktree, with nothing unsaved."));
  }
  return lines;
}

function branchLabel(entry) {
  if (entry.branch) return entry.branch;
  return entry.detached ? "(detached)" : entry.bare ? "(bare)" : "—";
}

function worktreeState(entry) {
  if (entry.locked !== undefined) return "locked";
  if (entry.prunable !== undefined) return "prunable";
  if (entry.readable === false) return "missing";
  if (entry.blocking > 0) return `${entry.blocking} unsaved`;
  if (entry.changes > 0) return "clean";
  return "clean";
}

function worktreeTone(entry) {
  if (entry.readable === false || entry.prunable !== undefined) return "bad";
  if (entry.locked !== undefined || entry.blocking > 0) return "warn";
  return "ok";
}

// ETNPilot's own merge requests first, then everyone else's for the same
// target: what lands before ours is what breaks ours. Read from GitLab, since
// a receipt is sealed before publishing and cannot carry this.
export function renderMerges(state, { style, width, height, cursor, now, merges }) {
  if (merges === undefined) return [style.dim("Reading the merge requests…")];
  if (merges.configured === false) {
    return [style.dim(merges.reason ?? "No GitLab project is configured."), "", style.dim("Everything else here works without it.")];
  }
  if (merges.available === false) {
    return [
      style.bad(`GitLab did not answer for ${merges.project}.`),
      "",
      ...wrap(merges.error ?? "", width - 2).map((line) => `  ${style.ink(line)}`),
      "",
      style.dim("This view is the only one that needs the network and a token; 'g' tries again."),
    ];
  }
  const entries = merges.entries ?? [];
  const ours = merges.ours ?? 0;
  const summary = [
    merges.project,
    `${entries.length} ${merges.state ?? "opened"}`,
    ours > 0 ? `${ours} ours` : "none of them ours",
    `target ${merges.targetBranch ?? "main"}`,
  ].join(" · ");
  if (entries.length === 0) {
    return [style.dim(summary), "", style.dim("Nothing is open. A published run appears here as a draft.")];
  }
  const columns = [
    { label: "MR", width: 7, value: (entry) => `!${entry.iid}`, tone: (entry) => (entry.own ? "accent" : "muted") },
    { label: "TITLE", width: Math.max(20, Math.floor(width * 0.34)), value: (entry) => entry.title },
    { label: "BRANCH", width: Math.max(16, Math.floor(width * 0.2)), value: (entry) => entry.sourceBranch },
    { label: "WHOSE", width: 12, value: (entry) => (entry.own ? "ours" : entry.author || "someone"),
      tone: (entry) => (entry.own ? "accent" : "muted") },
    { label: "MERGE", width: 16, value: (entry) => mergeLabel(entry), tone: (entry) => mergeTone(entry) },
    { label: "UPDATED", width: 9, value: (entry) => since(entry.updatedAt, now) },
  ];
  const ordered = mergeEntries(merges);
  const lines = [style.dim(summary), "", ...table(ordered, columns, { style, width, height: height - 2, cursor })];
  if (merges.truncated) {
    lines.push("", style.dim(`Showing ${entries.length} of ${merges.truncated}; the rest are in GitLab.`));
  }
  const selected = ordered[clamp(cursor, ordered.length)];
  if (selected) lines.push("", style.dim(truncate(selected.webUrl ?? "", width)));
  return lines;
}

// Ours first: they are the ones this window can do something about. The app
// selects from this same order, or the cursor would point at another row than
// the one under it.
export function mergeEntries(merges) {
  const entries = merges?.entries ?? [];
  return [...entries].sort((left, right) => Number(right.own) - Number(left.own) || right.iid - left.iid);
}

function mergeLabel(entry) {
  if (entry.hasConflicts) return "conflicts";
  if (entry.state && entry.state !== "opened") return entry.state;
  const status = (entry.mergeStatus ?? "").replaceAll("_", " ");
  if (entry.draft) return status === "mergeable" || status === "" ? "draft" : `draft · ${status}`;
  return status || "open";
}

function mergeTone(entry) {
  if (entry.hasConflicts || entry.state === "closed") return "bad";
  if (entry.state === "merged") return "ok";
  if (entry.draft) return "warn";
  return entry.mergeStatus === "mergeable" ? "ok" : "muted";
}

function table(rows, columns, { style, width, height, cursor }) {
  const heading = columns.map((column) => style.dim(pad(column.label, column.width))).join(" ");
  const lines = [`  ${heading}`];
  const visibleRows = Math.max(1, height - 1);
  const selectedIndex = clamp(cursor, rows.length);
  for (const row of window(rows, cursor, visibleRows)) {
    const selected = rows.indexOf(row) === selectedIndex;
    const cells = columns.map((column) => {
      const text = pad(String(column.value(row) ?? ""), column.width);
      return column.tone ? style.tone(text, column.tone(row)) : (selected ? style.ink(text) : style.muted(text));
    }).join(" ");
    lines.push(`${selected ? style.accent("›") : " "} ${cells}`);
  }
  return lines.map((line) => truncate(line, width));
}

// Keeps the selected row on screen without redrawing the world around it.
// The same tree the page renders as nested, clickable rows — flattened, with
// each row's depth, so the terminal interface can move a cursor over it.
export function flattenAgents(nodes, depth = 0) {
  const rows = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    rows.push(...flattenAgents(node.children, depth + 1));
  }
  return rows;
}

export function window(items, cursor, size) {
  if (items.length <= size) return items;
  const selected = clamp(cursor, items.length);
  const start = Math.min(Math.max(0, selected - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

export function clamp(cursor, length) {
  if (length === 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}

export function wrap(text, width) {
  if (width <= 0) return [text];
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    lines.push(current);
  }
  return lines;
}

function subject(approval) {
  const details = approval.details ?? {};
  return details.command ?? details.url ?? details.file ?? details.tool ?? "(no detail recorded)";
}

function kindLabel(kind, style) {
  const text = String(kind ?? "unknown").toUpperCase();
  const tone = kind === "shell" ? "warn" : kind === "write" ? "accent" : kind === "network" ? "bad" : "muted";
  return style.tone(padStart(text, 7), tone);
}

function stepTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "bad";
  if (status === "blocked") return "warn";
  return "muted";
}

function statusTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "bad";
  return "warn";
}

function queueTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "orphaned") return "bad";
  if (status === "running") return "warn";
  return "muted";
}

function renderRunDetail(state, { style, width, height, cursor, receipt, verification, agentMode = false, agentCursor = 0 }) {
  const runs = state.runs ?? [];
  const run = runs[clamp(cursor, runs.length)];
  if (!run) return [style.dim("No runs have been recorded yet.")];
  const lines = [
    `${style.bold(style.ink(run.runId))} ${style.tone(run.status, statusTone(run.status))} ${style.dim(`${run.mode} · ${duration(run.durationMs)}`)}`,
    "",
  ];
  if (!receipt || receipt.file !== run.receiptFile) return [...lines, style.dim("Reading the receipt…")];
  const terminal = receipt.terminal ?? {};
  const field = (label, value) => {
    if (value === undefined || value === "") return;
    lines.push(style.dim(label));
    for (const piece of wrap(String(value), width - 2)) lines.push(`  ${style.ink(piece)}`);
    lines.push("");
  };
  const outcome = receipt.outcome ?? { reasons: [], steps: [] };
  if (outcome.reasons.length > 0) {
    lines.push(style.dim(run.status === "succeeded" ? "Worth knowing" : "Why it ended"));
    for (const reason of outcome.reasons) {
      const text = `${reason.step ? `${reason.step}: ` : ""}${reason.text}`;
      const tone = reason.kind === "publication" || reason.kind === "blocked" ? "warn" : "bad";
      for (const [index, piece] of wrap(text, width - 4).entries()) {
        lines.push(`  ${index === 0 ? style.tone(piece, tone) : style.muted(piece)}`);
      }
    }
    lines.push("");
  }
  // The agents that ran, as the tree they ran in. In agent mode this list is
  // what 'enter' opens; ETNPilot never invents a hierarchy that did not run —
  // today every provider is flat, so this reads as one row per step, and
  // nests the day a provider actually spawns a subagent.
  const flatAgents = flattenAgents(outcome.agents ?? []);
  if (flatAgents.length > 0) {
    lines.push(style.dim(agentMode ? "Agents — ↑↓ move, enter to read" : "Agents — press 'a'"));
    const selected = agentMode ? clamp(agentCursor, flatAgents.length) : -1;
    for (const [index, row] of flatAgents.entries()) {
      const marker = agentMode && index === selected ? style.accent("›") : " ";
      const indent = "  ".repeat(row.depth);
      const label = (row.node.workflowStep ? `${row.node.workflowStep} · ` : "") + row.node.agent;
      lines.push(`${marker} ${indent}${style.tone(pad(row.node.status, 10), stepTone(row.node.status))} `
        + `${style.ink(truncate(label, width - 30))} ${style.muted(duration(row.node.durationMs))}`);
    }
    lines.push("");
  }
  if (outcome.steps.length > 1) {
    lines.push(style.dim("Steps"));
    for (const step of outcome.steps) {
      lines.push(`  ${style.tone(pad(step.status, 10), stepTone(step.status))} ${style.ink(pad(step.id, 18))} ${style.muted(step.error ?? "")}`);
    }
    lines.push("");
  }
  // What the providers cost. A surface that never shows this leaves a budget
  // nobody can see.
  const usage = outcome.usage;
  if (usage?.invocations) {
    const cost = usage.estimatedCost === undefined
      ? "not priced"
      : `${usage.currency ? `${usage.currency} ` : ""}${usage.estimatedCost.toFixed(4)}`;
    lines.push(style.dim("Usage"));
    lines.push(`  ${style.ink(`${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`)} ${style.muted(`${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · ${usage.cacheReadTokens.toLocaleString()} cached`)}`);
    lines.push(`  ${style.ink(`${usage.invocations} provider calls`)} ${style.muted(cost)}`);
    lines.push("");
  }
  if (outcome.tools) {
    lines.push(style.dim("Tools it used"));
    for (const row of outcome.tools) {
      const refused = row.failed > 0 ? style.bad(`${row.failed} refused`) : style.muted("none refused");
      lines.push(`  ${style.ink(pad(row.tool, 14))} ${style.muted(`${row.ok} ran`)} ${refused} ${style.muted(row.error ?? "")}`);
    }
    lines.push("");
  }
  field("Branch", terminal.workspace?.branch);
  // Where the files are: a worktree run leaves them there, not in the checkout.
  field("Workspace", terminal.workspace?.path);
  field("Sandbox", terminal.workspace?.sandbox?.image);
  const rehearsal = outcome.rehearsal;
  if (rehearsal) {
    lines.push(style.dim("Merge rehearsal"));
    const tone = rehearsal.state === "clean" ? "ok" : rehearsal.state === "conflicts" ? "bad" : "warn";
    for (const [index, piece] of wrap(rehearsal.text, width - 4).entries()) {
      lines.push(`  ${index === 0 ? style.tone(piece, tone) : style.muted(piece)}`);
    }
    if (rehearsal.error) for (const piece of wrap(rehearsal.error, width - 4)) lines.push(`  ${style.muted(piece)}`);
    lines.push("");
  }
  // Which settings were in effect is evidence, so it belongs next to the run
  // rather than only in the file.
  if (terminal.settings) {
    lines.push(style.dim("Settings in effect"));
    lines.push(`  ${style.muted(terminal.settings.layers.map((layer) => layer.source).join(" → "))}`);
    const overrides = terminal.settings.overrides ?? [];
    lines.push(overrides.length === 0
      ? `  ${style.ok("the committed default, unchanged")}`
      : `  ${style.warn(`${overrides.length} changed locally`)} ${style.muted(overrides.join(", "))}`);
    lines.push("");
  }
  const approvals = receipt.entries.flatMap((entry) => entry.approvals ?? []);
  if (approvals.length > 0) {
    lines.push(style.dim(`Approvals (${approvals.length})`));
    // Three lines are held back for the receipt below. A count that disagrees
    // with the rows under it is worse than a list that says it is short.
    const room = Math.max(1, height - lines.length - 3);
    for (const approval of approvals.slice(0, room)) {
      const tone = approval.decision === "approve-once" ? "ok" : "bad";
      lines.push(`  ${style.tone(padStart(String(approval.operationKind).toUpperCase(), 7), tone)} ${style.muted(approval.decision)} ${style.dim(approval.evidence?.decidedBy ?? "")}`);
    }
    if (approvals.length > room) lines.push(style.dim(`  … ${approvals.length - room} more, in the receipt`));
    lines.push("");
  }
  lines.push(style.dim("Receipt"));
  lines.push(`  ${style.muted(run.receiptFile)} · ${run.entries} entries · ${run.signed ? style.ok("signed") : style.warn("unsigned")}`);
  // Whether it verifies is a different claim from what it says, so it is only
  // here once it has been checked — and it never reads as 'not checked yet'
  // and 'checked, and fine' the same way.
  if (verification === undefined) {
    lines.push(`  ${style.dim("press 'v' to check its hash chain and signatures")}`);
  } else if (verification.file !== run.receiptFile) {
    lines.push(`  ${style.dim("checking…")}`);
  } else {
    lines.push(`  ${style.tone(verification.valid ? "verified" : "DOES NOT VERIFY", verification.tone)}`
      + ` ${style.muted(`${verification.encoding ?? ""}`)}`);
    for (const piece of wrap(verification.text, width - 4)) {
      lines.push(`  ${verification.valid ? style.muted(piece) : style.bad(piece)}`);
    }
  }
  if (terminal.error) {
    lines.push("", style.dim("Error"));
    for (const piece of wrap(terminal.error, width - 2)) lines.push(`  ${style.bad(piece)}`);
  }
  return lines.slice(0, height);
}

function renderHelp({ style, width, height, offset = 0 }) {
  const sections = HELP_SECTIONS;
  const render = ([title, keys], columnWidth) => [
    style.dim(title),
    ...keys.map(([key, label]) => truncate(`  ${style.accent(pad(key, 10))} ${style.ink(label)}`, columnWidth)),
    "",
  ];
  const single = trimTrailing(sections.flatMap((section) => render(section, width)));
  const rows = single.length <= height ? single : twoColumns(sections, render, width);
  if (rows.length <= height) return rows;

  // Below a certain height nothing lays out. Help that scrolls off the bottom
  // without saying so teaches the wrong keys, so the cut is on screen.
  const start = Math.min(Math.max(0, offset), rows.length - (height - 1));
  const visible = rows.slice(start, start + height - 1);
  const more = rows.length - start - visible.length;
  visible.push(style.dim(more > 0 ? `↑↓ scroll · ${more} more lines` : "↑↓ scroll · the end"));
  return visible;
}

export function helpLength(width, height) {
  // Minus one for the blank line the last section in a column does not get.
  const measure = (sections) => sections.reduce(
    (total, [title, keys]) => total + keys.length + 2,
    0,
  ) - (sections.length > 0 ? 1 : 0);
  const single = measure(HELP_SECTIONS);
  if (single <= height) return single;
  const half = Math.ceil(HELP_SECTIONS.length / 2);
  return Math.max(measure(HELP_SECTIONS.slice(0, half)), measure(HELP_SECTIONS.slice(half)));
}

function twoColumns(sections, render, width) {
  const columnWidth = Math.floor((width - 2) / 2);
  const half = Math.ceil(sections.length / 2);
  // The blank line under a section separates it from the next one. The last
  // section in a column has no next one, and that spare line is the
  // difference between the whole help fitting and a scrollbar — which was
  // what adding a seventh view did to it.
  const left = trimTrailing(sections.slice(0, half).flatMap((section) => render(section, columnWidth)));
  const right = trimTrailing(sections.slice(half).flatMap((section) => render(section, columnWidth)));
  const rows = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    rows.push(`${pad(left[index] ?? "", columnWidth)}  ${right[index] ?? ""}`);
  }
  return rows;
}

function trimTrailing(rows) {
  const trimmed = [...rows];
  while (trimmed.length > 0 && trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

const HELP_SECTIONS = Object.freeze([
  ["Everywhere", [
    ["tab / 1-7", "switch view"],
    ["↑ ↓ / k j", "move the cursor"],
    ["n", "start a run"],
    ["g", "refresh now"],
    ["?", "this help"],
    ["q / ^c", "quit"],
  ]],
  ["Approvals", [
    ["enter", "open in full, with the rule"],
    ["a / r", "approve once / reject"],
    ["esc", "back to the list"],
  ]],
  ["Runs", [
    ["enter", "open the receipt"],
    ["a", "its agents, as a tree — enter reads one"],
    ["v", "check its hash chain and signatures"],
  ]],
  ["Queue", [["c", "request cancellation"], ["R", "resume a failed job"]]],
  ["Worktrees", [
    ["enter", "the files it holds, then one file's diff"],
    ["x", "remove it, if it is clean"],
    ["g", "read them again"],
  ]],
  ["Merge requests", [["↑↓", "ours first, then others"], ["g", "ask GitLab again"]]],
  ["Checks", [
    ["enter", "run the selected check"],
    ["A", "run all of them, in order"],
  ]],
  ["Settings", [
    ["enter", "edit"],
    ["d", "back to the default"],
    ["s", "local or ~/.config"],
    ["/", "filter"],
  ]],
]);

// The settings list and its editor. Which entries are on screen is a pure
// function of the filter, so the app selects exactly what a person can see.
export function settingEntries(state, { filter = "" } = {}) {
  const entries = state.settings?.entries ?? [];
  const needle = filter.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
}

function renderSettings(state, { style, width, height, cursor, filter, filtering, scope }) {
  const settings = state.settings;
  if (settings?.error) {
    return [
      style.bad("The local settings file was refused."),
      "",
      ...wrap(settings.error, width - 2).map((line) => `  ${style.ink(line)}`),
      "",
      style.dim("Fix the file, or remove the setting with 'etnpilot config unset'."),
    ];
  }
  const entries = settingEntries(state, { filter });
  const changed = settings?.overrides?.length ?? 0;
  const summary = [
    `${entries.length} ${entries.length === 1 ? "setting" : "settings"}`,
    changed > 0 ? `${changed} changed locally` : "none changed",
    `writing to ${scope}`,
  ].join(" · ");
  // While the filter is being typed the input line at the bottom carries it,
  // caret and all. Repeating it here would put two carets on one screen.
  const head = [style.dim(summary) + (!filtering && filter ? style.dim(`  ·  filter '${filter}'`) : ""), ""];
  // A refused setting would stop the next run. Saying so here, above the list,
  // is the difference between a warning and a surprise an hour later.
  const refusals = settings?.refusals ?? [];
  if (refusals.length > 0) {
    head.unshift(
      style.bad(refusals.length === 1
        ? "1 local setting is refused; a run will not start until it is gone:"
        : `${refusals.length} local settings are refused; a run will not start until they are gone:`),
      ...refusals.slice(0, 3).flatMap((refusal) => wrap(`${refusal.path} — ${refusal.reason}`, width - 4)
        .map((line) => `  ${style.muted(line)}`)),
      "",
    );
  }
  if (entries.length === 0) return [...head, style.dim("Nothing matches that filter.")];
  const columns = [
    { label: "SETTING", width: Math.max(24, Math.floor(width * 0.4)), value: (entry) => entry.path },
    { label: "VALUE", width: Math.max(14, Math.floor(width * 0.25)), value: (entry) => settingValue(entry.value) },
    { label: "FROM", width: 12, value: (entry) => sourceLabel(entry.source), tone: (entry) => (entry.source === "project" ? "muted" : "accent") },
    { label: "CHANGE", width: 14, value: (entry) => entry.mode, tone: (entry) => modeTone(entry.mode) },
  ];
  return [...head, ...table(entries, columns, { style, width, height: height - head.length, cursor })];
}

// What the editor starts from: JSON is valid YAML, so a value round-trips
// through the prompt unchanged unless the person edits it.
export function settingLiteral(value) {
  return value === undefined ? "" : JSON.stringify(value);
}

export function settingValue(value) {
  if (value === undefined) return "—";
  if (Array.isArray(value) && value.some((entry) => entry && typeof entry === "object")) {
    return `${value.length} entries`;
  }
  return JSON.stringify(value);
}

function sourceLabel(source) {
  if (source === "user-local") return "local";
  if (source === "user-global") return "global";
  return "committed";
}

function modeTone(mode) {
  if (mode === "locked") return "bad";
  if (mode === "stricter-only") return "warn";
  return "muted";
}

// One line at the bottom of the screen, the way every terminal tool does it:
// a prefix that says what is being typed, the text, and the caret. What was on
// screen stays there, which is the point — you can read the list you are
// filtering, or the approval you are about to answer, while you type.
function inputState({ prompt, editor, filtering, filter }) {
  if (editor) {
    return {
      prefix: `set ${editor.entry.path}`,
      value: editor.buffer,
      bad: Boolean(editor.error),
      // Where a setting accepts only certain values, those values are the
      // useful fact and they take the place of the default, which is one of
      // them. The line is cut from the right, so nothing else may grow.
      hint: editor.error ?? [
        editor.entry.mode,
        editor.entry.choices
          ? `${editor.entry.choices.kind === "set" ? "any of" : "one of"}: ${editor.entry.choices.values.map((value) => JSON.stringify(value)).join(", ")}`
          : `default ${settingValue(editor.entry.defaultValue)}`,
        `writing ${editor.scope === "global" ? "~/.config" : "this project, locally"}`,
        "enter saves · esc cancels",
      ].join(" · "),
    };
  }
  if (prompt) {
    const agent = prompt.agent
      || (prompt.steps?.length > 0 ? `the project's workflow: ${prompt.steps.join(" → ")}` : "the project's default agent");
    return prompt.field === "agent"
      ? {
          prefix: "agent",
          value: prompt.agent,
          bad: Boolean(prompt.error),
          hint: prompt.error ?? `task: ${prompt.buffer || "(none yet)"} · tab back to the task · enter starts`,
        }
      : {
          prefix: "run",
          value: prompt.buffer,
          bad: Boolean(prompt.error),
          hint: prompt.error ?? `agent: ${agent} · tab to name one · enter starts · esc cancels`,
        };
  }
  if (filtering) {
    return { prefix: "/", bare: true, value: filter, hint: "enter keeps the filter · esc clears it" };
  }
  return undefined;
}

function inputLine(input, { style, width }) {
  const prefix = input.bare
    ? style.accent(input.prefix)
    : `${style.accent(input.prefix)}${style.dim("> ")}`;
  // The caret has to stay visible even where the text is longer than the line,
  // so a long value is cut at the front rather than the end.
  const room = Math.max(1, width - displayWidth(prefix) - 1);
  const value = input.value.length > room ? `…${input.value.slice(-(room - 1))}` : input.value;
  return prefix + style.ink(value) + style.invert(" ");
}
