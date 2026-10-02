import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { languageFrom, translateSegment } from "../src/i18n/translate.js";
import { displayWidth, stripAnsi } from "../src/tui/ansi.js";
import { renderApp } from "../src/tui/render.js";

const iso = (offset) => new Date(Date.now() - offset).toISOString();
const state = () => ({
  approvals: { pending: [{ id: "a1", operationKind: "shell", agent: "builder", runId: "20260923-4f2a9c1b", createdAt: iso(240_000), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), details: { command: "npm test" }, policy: { rule: "shell-with-review", effect: "human" } }], recent: [] },
  queue: { counts: { queued: 2, running: 1 }, jobs: [{ id: "d71151cd-aaaa", kind: "gitlab-issue", status: "running", attempts: 1, updatedAt: iso(30_000) }] },
  runs: [{ runId: "20260923-4f2a9c1b", status: "succeeded", mode: "execute", terminal: true, signed: true, approvals: 2, durationMs: 48_123 }],
});
const base = { color: false, now: Date.now(), checks: [{ id: "doctor", title: "doctor", about: "x" }], chat: { turns: [], notes: [], running: false, choice: {}, compactions: [] }, worktrees: { entries: [] }, merges: { configured: false, entries: [] } };
const VIEWS = ["approvals", "runs", "queue", "settings", "worktrees", "merges", "checks", "chat"];

test("English stays the default, and German is chosen by ETNPILOT_LANG or the locale", () => {
  assert.equal(languageFrom({}), "en");
  assert.equal(languageFrom({ LANG: "de_DE.UTF-8" }), "de");
  assert.equal(languageFrom({ LANG: "de_DE.UTF-8", ETNPILOT_LANG: "en" }), "en");
  assert.equal(languageFrom({ LC_ALL: "en_US.UTF-8", LANG: "de_DE.UTF-8" }), "en", "the locale's most specific variable wins");
  const english = renderApp(state(), { ...base, width: 96, height: 20 }).join("\n");
  assert.match(english, /2 waiting|1 waiting/);
  assert.match(english, /quit/);
  assert.doesNotMatch(english, /beenden/);
});

test("in German the header, the lists, the empty states and the keys are German", () => {
  const german = (view, extra = {}) => renderApp(state(), { ...base, view, width: 100, height: 24, language: "de", ...extra }).join("\n");
  const approvals = german("approvals");
  assert.match(approvals, /1 wartend · älteste 4m/);
  assert.match(approvals, /genehmigen/);
  assert.match(approvals, /beenden/);
  assert.match(german("runs"), /MODUS/);
  assert.match(german("runs"), /erfolgreich/);
  assert.match(german("queue"), /wartet 2 · läuft 1/);
  assert.match(renderApp({ ...state(), approvals: { pending: [] } }, { ...base, width: 80, height: 12, language: "de" }).join("\n"), /Nichts wartet auf eine Entscheidung/);
  assert.match(german("checks"), /Prüfungen/);
  assert.match(german("approvals", { help: true }), /Überall/);
});

test("the German frame fits the terminal at every view and width, in colour and without", () => {
  for (const view of VIEWS) {
    for (const [width, height] of [[100, 24], [64, 18], [40, 12]]) {
      for (const color of [true, false]) {
        const frame = renderApp(state(), { ...base, view, width, height, color, language: "de" });
        assert.equal(frame.length, height, `${view} ${width}x${height}`);
        for (const line of frame) assert.ok(displayWidth(line) <= width, `${view} ${width}: too wide: ${JSON.stringify(stripAnsi(line))}`);
      }
    }
  }
});

test("a translated word keeps the column it was padded to, and a sentence is not cut by it", () => {
  assert.equal(translateSegment("MODE    ", "de"), "MODUS   ");
  assert.equal(translateSegment("  yes", "de"), "  ja ", "a shorter word keeps the width");
  assert.equal(translateSegment("running", "en"), "running");
  assert.equal(translateSegment("a-run-id-20260923", "de"), "a-run-id-20260923", "what is not in the catalog is left as it is");
  assert.equal(translateSegment("SEALED ", "de").length >= "VERSIEG.".length, true);
});

test("every German terminal text is for a text the terminal can show", async () => {
  const { DE_TUI } = await import("../src/i18n/de-tui.js");
  const files = (await readdir(new URL("../src/tui/", import.meta.url))).filter((name) => name.endsWith(".js"));
  const source = (await Promise.all(files.map((name) => readFile(new URL(`../src/tui/${name}`, import.meta.url), "utf8")))).join("\n").replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ");
  // The words a view shows for what the state says (a status, a mode) come from
  // the state, not from a literal here.
  const fromState = new Set(["agent: the project's default", "model the agent's own", "effort the agent's own", "yes", "no", "human", "deny", "allow", "pending", "approved", "rejected", "expired", "stale", "configured", "opened", "merged", "closed", "mergeable", "cancelled", "done", "queued", "ok", "unknown", "you", "blocked", "orphaned", "running", "succeeded"]);
  const dead = Object.keys(DE_TUI).filter((key) => !fromState.has(key) && !source.includes(key) && !source.includes(JSON.stringify(key).slice(1, -1)));
  assert.deepEqual(dead, []);
});

test("the first-run screen and the chat view are German too, and English is untouched", async () => {
  const { renderFirstRun } = await import("../src/tui/first-run.js");
  const status = { root: "/x", checkout: { inside: false }, templates: [{ id: "default", about: "Everything on: the code graph, telemetry, and pinned project content.", changes: [] }], importable: null, forge: null };
  const german = renderFirstRun(status, { width: 120, height: 24, color: false, language: "de" }).join("\n");
  assert.match(german, /hier gibt es noch kein Projekt/);
  assert.match(german, /Das ist kein Git-Checkout/);
  assert.match(german, /anlegen/);
  const english = renderFirstRun(status, { width: 120, height: 24, color: false }).join("\n");
  assert.match(english, /no project here yet/);
  assert.match(english, /create it/);
  const chat = { turns: [{ turn: 1, input: "hi", status: "succeeded", reply: "hello", calls: [] }], notes: [], choice: { agent: "worker" }, compactions: [] };
  const view = renderApp(state(), { ...base, view: "chat", chat, width: 100, height: 14, language: "de" }).join("\n");
  assert.match(view, /Agent worker · Modell der des Agenten · Aufwand der des Agenten/);
  assert.match(view, /du\s+hi/);
});
