// @ts-check
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AUTHOR_KINDS, IMPROVE_KINDS, applyDraft, draftImprovement, draftNew, listItems, refineDraft, renderDiff } from "../forge/author.js";
import { describeLastWrite, undoLastWrite } from "../forge/author-undo.js";

// The page's side of 'etnpilot author'. A draft is made on request and kept
// here; the page can only accept a draft by its id, so it can never ask for a
// text or a path of its own to be written. A draft is dropped once accepted.
const MAX_DRAFTS = 8;

export function createAuthorRoutes({ root, env = process.env, getConfig, fetchImpl, runModel, factories = undefined }) {
  const drafts = new Map();

  function keep(draft) {
    while (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
    const id = randomBytes(10).toString("hex");
    drafts.set(id, draft);
    return id;
  }

  return async function handle(method, pathname, body) {
    if (!pathname.startsWith("/api/author")) return undefined;
    try {
      if (method === "POST" && pathname === "/api/author/draft") {
        const options = { root, config: getConfig(), env, fetchImpl, runModel, factories };
        const request = typeof body?.request === "string" ? body.request : "";
        const draft = body?.mode === "improve"
          ? await draftImprovement(String(body?.kind), String(body?.name ?? ""), request, options)
          : await draftNew(String(body?.kind), request, options);
        return { status: 200, body: describe(keep(draft), draft) };
      }
      if (method === "POST" && pathname === "/api/author/refine") {
        const id = String(body?.id ?? "");
        const draft = drafts.get(id);
        if (!draft) return { status: 404, body: { error: "That draft is gone. Ask for it again.", code: "unknown_draft" } };
        const refined = await refineDraft(draft, typeof body?.request === "string" ? body.request : "", { root, config: getConfig(), env, fetchImpl, runModel, factories });
        drafts.delete(id);
        return { status: 200, body: describe(keep(refined), refined) };
      }
      if (method === "POST" && pathname === "/api/author/undo") {
        return { status: 200, body: await undoLastWrite(root) };
      }
      if (method === "POST" && pathname === "/api/author/apply") {
        const id = String(body?.id ?? "");
        const draft = drafts.get(id);
        if (!draft) return { status: 404, body: { error: "That draft is gone. Ask for it again.", code: "unknown_draft" } };
        const result = await applyDraft(draft, { root });
        drafts.delete(id);
        const written = result.written ?? [...result.agents, ...result.skills, ...result.instructions, ...(result.prompts ?? [])].map((entry) => entry.to);
        return { status: 200, body: { written, skipped: result.skipped ?? [], undoable: Boolean(result.undoId) } };
      }
      if (method === "POST" && pathname === "/api/author/items") {
        return { status: 200, body: { names: await listItems(String(body?.kind), join(root, ".etnpilot")) } };
      }
      if (method === "POST" && pathname === "/api/author/discard") {
        drafts.delete(String(body?.id ?? ""));
        return { status: 200, body: { ok: true } };
      }
      if (method === "GET" && pathname === "/api/author") {
        return { status: 200, body: { kinds: AUTHOR_KINDS, improve: IMPROVE_KINDS, last: await describeLastWrite(root) ?? null } };
      }
    } catch (error) {
      const known = ["no_provider", "bad_answer", "empty", "missing", "changed", "nothing"].includes(error.code) || error instanceof TypeError;
      return { status: known ? 400 : 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
    }
    return undefined;
  };
}

function describe(id, draft) {
  const provider = draft.provider ? { name: draft.provider.name, model: draft.provider.model, preferred: draft.provider.preferred } : undefined;
  if (draft.mode === "new") {
    const item = draft.plan.agents[0] ?? draft.plan.skills[0] ?? draft.plan.instructions[0] ?? draft.plan.prompts[0];
    return { id, mode: "new", kind: draft.kind, preview: draft.preview, notes: draft.notes ?? [], text: item.prompt ?? item.body, provider };
  }
  return { id, mode: "improve", kind: draft.kind, name: draft.name, path: draft.path, summary: draft.summary, diff: renderDiff(draft.diff), files: draft.edits.map((edit) => ({ path: edit.path, text: edit.after })), provider };
}
