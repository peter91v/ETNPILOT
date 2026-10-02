// @ts-check
import { readRegularFile } from "./bounded-io.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { compactSession, compactionCheck, createSessionId, listSessions, readSession, runChatTurn, undoLastTurn, verifySession } from "./chat-session.js";
import { resolveAttachments, summarizeAttachments } from "./chat-attachments.js";
import { readAgents } from "./project-reads.js";
import { verifyProjectReceipt } from "./receipt-views.js";
import { PolicyEngine } from "../policy/engine.js";
import { git } from "../git/command.js";
import { join } from "node:path";

// The conversation half of a project's state. `scope` is what the state shares
// with it (project root, the runs being tracked, the current configuration);
// `self` is the state, for starting a run, which is the caller's to do.
export function chatApi(scope, self) {
  const { projectRoot, runsDirectory, running } = scope;
  return {
  list: () => listSessions(projectRoot),
  read: async (id) => {
    const session = await readSession(projectRoot, id);
    // Whether a turn is going now is known here and nowhere on disk.
    const active = [...running].find((record) => record.session === id);
    return { ...session, running: Boolean(active), ...(active?.partial ? { partial: active.partial } : {}) };
  },
  verify: (id) => verifySession(projectRoot, id, {
    verifyReceipt: (file) => verifyProjectReceipt(runsDirectory, file, { root: projectRoot, config: scope.config }),
    readEntries: async (file) => {
      const text = await readRegularFile(join(runsDirectory, file), 16 * 1024 * 1024).then((bytes) => bytes.toString("utf8"));
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  }),
  // Files a person can name with '@': what git tracks, minus what the read
  // policy refuses them. The same set search_files searches.
  async files(query = "", { limit = 50 } = /** @type {any} */ ({})) {
    const listed = await git(["ls-files", "-z"], { cwd: projectRoot, trim: false }).catch(() => ({ stdout: "" }));
    const policy = new PolicyEngine(scope.config.policy);
    const needle = String(query).toLowerCase();
    const found = [];
    for (const path of listed.stdout.split("\0").filter(Boolean)) {
      if (needle && !path.toLowerCase().includes(needle)) continue;
      const verdict = policy.evaluateOperation({ kind: "read", path }, { workspace: projectRoot });
      if (verdict?.kind === "reject") continue;
      found.push(path);
      if (found.length >= limit) break;
    }
    return found;
  },
  // One turn of a conversation, started the way any run from a surface is:
  // its approvals land in the inbox this page already shows. Not awaited.
  async send({ sessionId, text, agent, model, provider, effort, providerFactories } = /** @type {any} */ ({})) {
    if (typeof text !== "string" || text.trim() === "") throw new TypeError("A message is required.");
    const id = sessionId ?? createSessionId();
    if ([...running].some((record) => record.session === id)) {
      throw new Error("A turn is already running in this conversation. Wait for it, or stop it.");
    }
    const lease = await acquireWorkspaceLease(projectRoot, { sessionId: id });
    try {
    const names = (await readAgents({ root: projectRoot, config: scope.config })).agents.filter((entry) => !entry.error).map((entry) => entry.name);
    const chosen = agent ?? scope.config.defaultAgent ?? "orchestrator";
    if (!names.includes(chosen)) throw new TypeError(`Unknown agent '${chosen}'. This project has: ${names.join(", ")}.`);
    if (provider) {
      const verdict = new PolicyEngine(scope.config.policy).evaluateProvider(provider, { agent: chosen });
      if (verdict.allowed === false) throw new Error(/** @type {any} */ (verdict).reason ?? `The policy does not allow provider '${provider}'.`);
      if (!scope.config.providers?.[provider]) throw new TypeError(`No provider '${provider}' is configured.`);
    }
    const policy = new PolicyEngine(scope.config.policy);
    const { attachments, refused } = await resolveAttachments(text, {
      root: projectRoot,
      authorize: (path) => policy.evaluateOperation({ kind: "read", path }, { agent: chosen, workspace: projectRoot }),
    });
    const override = model || provider || effort ? { model, provider, effort } : undefined;
    const started = self.startRun({
      input: text.trim(),
      agent: chosen,
      providerFactories,
      session: id,
      // 'input' is dropped: the turn composes its own, with the attachments.
      via: ({ input: _task, agent: _agent, ...options }) => runChatTurn({
        ...options,
        workspaceLease: lease,
        sessionId: id,
        text: text.trim(),
        agent: chosen,
        attachments,
        agentOverride: override,
      }),
    });
    // A failure is reported through runErrors like any run's; nothing here waits.
    started.finally(() => lease.release()).catch(() => {});
    return { sessionId: id, agent: chosen, attached: summarizeAttachments(attachments), refused };
    } catch (error) { lease.release(); throw error; }
  },
  // Asks the model to summarise the older turns, as a run of its own. The
  // answer is not awaited; it lands in the session as a 'compact' line.
  async compact(id, { agent, model, provider, effort, providerFactories } = /** @type {any} */ ({})) {
    const check = await compactionCheck(projectRoot, id);
    if (!check.ok) return check;
    if ([...running].some((record) => record.session === id)) {
      return { ok: false, message: "A turn is running in this conversation; wait for it." };
    }
    const chosen = agent ?? scope.config.defaultAgent ?? "orchestrator";
    const override = model || provider || effort ? { model, provider, effort } : undefined;
    const started = self.startRun({
      input: "Summarise the conversation",
      agent: chosen,
      providerFactories,
      session: id,
      via: ({ input: _task, agent: _agent, ...options }) => compactSession({ ...options, sessionId: id, agent: chosen, agentOverride: override }),
    });
    started.catch(() => {});
    return { ok: true, message: "Asking the model for a summary (one call). It appears in the conversation when it is written." };
  },
  // Takes back the newest turn's file changes. Not while a turn is running:
  // the files are moving.
  undo: async (id) => {
    if ([...running].some((record) => record.session === id)) {
      return { ok: false, message: "A turn is running in this conversation; stop it first." };
    }
    return undoLastTurn({ root: projectRoot, sessionId: id });
  },
  stop: (id) => {
    const mine = [...running].filter((record) => record.session === id);
    for (const record of mine) record.controller.abort();
    return mine.length;
  },
  };
}
