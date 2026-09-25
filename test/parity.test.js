import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// UI-4.3: the capability table, checking itself.
//
// 'Alle Varianten sollen alles können' is only true if something looks. Each
// row below names, per surface, the evidence that the capability is there —
// the CLI command, the terminal view or key, the HTTP route — and this file
// goes and finds it. A row that claims something the code does not have fails
// here, and the table in docs/roadmap-ui.md is regenerated from these same
// rows, so it cannot quietly go out of date either.
//
// What this does not claim: that a capability works. That is what the rest of
// the suite is for. This says only that every surface offers it, which is the
// promise that kept being broken.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The app is the review page, installed (UI-3). That is a decision, not an
// omission: it means the app's column is the web's column by construction,
// and there is no fourth implementation to keep level.
const APP_IS_THE_PAGE = true;

const CAPABILITIES = [
  {
    what: "Approvals: list and decide",
    cli: { usage: "etnpilot approval approve <id>" },
    tui: { key: '["a", "approve"]' },
    web: { route: '/api/approvals/decide' },
  },
  {
    what: "Approval in full, with the rule that stopped it",
    cli: { usage: "etnpilot approval show <id>" },
    tui: { render: "Why you are being asked" },
    web: { page: "← " },
  },
  {
    what: "Queue: list, cancel, resume",
    cli: { usage: "etnpilot queue resume <id>" },
    tui: { key: '["R", "resume"]' },
    web: { route: "/api/queue/resume" },
  },
  {
    what: "Runs: list",
    cli: { usage: "etnpilot receipt show [file]" },
    tui: { view: "runs" },
    web: { page: 'id: "runs"' },
  },
  {
    what: "A run's receipt in detail",
    cli: { usage: "etnpilot receipt show [file]" },
    tui: { render: "Merge rehearsal" },
    web: { route: "/api/runs/" },
  },
  {
    what: "The agents that ran, each one readable in full",
    cli: { usage: "--raw" },
    tui: { key: '["a", "agents"]' },
    web: { page: "agentTreeRows" },
  },
  {
    what: "Verify a receipt: hash chain and signatures",
    cli: { usage: "etnpilot receipt verify <file>" },
    tui: { key: '["v", "verify"]' },
    web: { route: "/api/verify/" },
  },
  {
    what: "Start a run",
    cli: { usage: "etnpilot run" },
    tui: { key: '["n", "run"]' },
    web: { route: "/api/runs/start" },
  },
  {
    what: "Settings: list, diff, change locally or globally",
    cli: { usage: "etnpilot config set <path> <value>" },
    tui: { key: '["s", "scope"]' },
    web: { route: "/api/settings/set" },
  },
  {
    what: "Worktrees: list, and remove only when clean",
    cli: { usage: "etnpilot worktree cleanup" },
    tui: { key: '["x", "remove if clean"]' },
    web: { route: "/api/worktrees/remove" },
  },
  {
    what: "What a worktree holds, and one file's diff",
    cli: { usage: "etnpilot worktree list" },
    tui: { key: '["enter", "what changed"]' },
    web: { route: "/api/worktrees/diff" },
  },
  {
    what: "The project's own merge requests",
    cli: { usage: "etnpilot merge list" },
    tui: { view: "merges" },
    web: { route: "/api/merges" },
  },
  {
    what: "The checks: doctor, policy, content, deps, secrets, telemetry",
    cli: { usage: "etnpilot check [name...]" },
    tui: { view: "checks" },
    web: { route: "/api/checks/run" },
  },
  {
    what: "A project where there is none yet",
    cli: { usage: "etnpilot init" },
    tui: { file: ["src/tui/first-run.js", "createFirstRunApp"] },
    web: { route: "/api/project/create" },
  },
  {
    what: "The models a provider can reach, and their published prices",
    cli: false,
    tui: false,
    web: { route: "/api/providers/" },
    open: "The combobox is the page's. The terminal takes a typed model name, and 'etnpilot config set' does not know what a provider offers.",
  },
  {
    what: "An SBOM, an attestation, a replay",
    cli: { usage: "etnpilot attest <receipt-file>" },
    tui: false,
    web: false,
    open: "Deliberate: these produce a file for a pipeline to consume, not a thing to look at.",
  },
];

const sources = {
  cli: await readFile(join(root, "src/cli/commands.js"), "utf8"),
  tuiApp: await readFile(join(root, "src/tui/app.js"), "utf8"),
  tuiRender: await readFile(join(root, "src/tui/render.js"), "utf8"),
  server: await readFile(join(root, "src/ui/server.js"), "utf8"),
  page: await readFile(join(root, "src/ui/page.js"), "utf8"),
};

test("every capability the table claims is in the code", async () => {
  const missing = [];
  for (const row of CAPABILITIES) {
    for (const surface of ["cli", "tui", "web"]) {
      const claim = row[surface];
      if (claim === false) continue;
      if (!await holds(surface, claim)) missing.push(`${row.what} — ${surface}: ${JSON.stringify(claim)}`);
    }
  }
  assert.deepEqual(missing, [], "claimed but not found:\n" + missing.join("\n"));
});

test("a capability that is open says so, and says why", () => {
  for (const row of CAPABILITIES) {
    const gaps = ["cli", "tui", "web"].filter((surface) => row[surface] === false);
    if (gaps.length === 0) continue;
    assert.equal(typeof row.open, "string", `${row.what} has a gap with no reason`);
    assert.equal(row.open.length > 20, true, row.what);
  }
});

test("the table in docs/roadmap-ui.md is the one these rows produce", async () => {
  const doc = await readFile(join(root, "docs/roadmap-ui.md"), "utf8");
  const expected = renderTable();
  assert.equal(
    doc.includes(expected),
    true,
    "docs/roadmap-ui.md is out of date. Replace its capability table with:\n\n" + expected,
  );
});

test("the app column is the web column, because the app is the page", () => {
  // UI-3 decided this. If somebody ever builds a separate app, this test is
  // where they find out that the table now needs a fourth column of its own.
  assert.equal(APP_IS_THE_PAGE, true);
  assert.match(sources.page, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(sources.server, /url\.pathname === "\/manifest\.webmanifest"/);
});

async function holds(surface, claim) {
  if (claim.usage) return sources.cli.includes(claim.usage);
  if (claim.route) return sources.server.includes(claim.route);
  if (claim.page) return sources.page.includes(claim.page);
  if (claim.view) return sources.tuiRender.includes(`"${claim.view}"`);
  if (claim.key) return sources.tuiRender.includes(claim.key);
  if (claim.render) return sources.tuiRender.includes(claim.render);
  if (claim.file) {
    const [path, needle] = claim.file;
    return (await readFile(join(root, path), "utf8")).includes(needle);
  }
  return false;
}

function renderTable() {
  const mark = (value) => (value === false ? "✗" : "✅");
  const lines = [
    "| Fähigkeit | CLI | TUI | Web | App |",
    "| --- | :-: | :-: | :-: | :-: |",
  ];
  for (const row of CAPABILITIES) {
    lines.push(`| ${row.what} | ${mark(row.cli)} | ${mark(row.tui)} | ${mark(row.web)} | ${mark(row.web)} |`);
  }
  return lines.join("\n") + "\n";
}

export { CAPABILITIES, renderTable };
