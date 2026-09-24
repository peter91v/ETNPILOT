import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReviewServer } from "../src/ui/server.js";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { WorkflowQueue } from "../src/workflow/queue.js";

test("the review UI serves state and records decisions", async () => {
  const root = await createProject();
  const inbox = new ApprovalInbox(join(root, ".etnpilot", "state", "approvals.sqlite"));
  const pending = inbox.create(
    { kind: "shell", fullCommandText: "npm publish --access public" },
    { runId: "run-1", agent: "builder" },
    { timeoutMs: 60_000 },
  );
  inbox.close();

  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const call = (path, options = {}) => fetch(base + path, {
      ...options,
      headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
    });

    const state = await (await call("/api/state")).json();
    assert.equal(state.approvals.pending.length, 1);
    // The reviewer sees the whole command, as at the terminal.
    assert.equal(state.approvals.pending[0].details.command, "npm publish --access public");
    assert.equal(state.runs.length, 1);
    assert.deepEqual(
      { runId: state.runs[0].runId, status: state.runs[0].status, terminal: state.runs[0].terminal },
      { runId: "run-9", status: "succeeded", terminal: true },
    );
    assert.equal(state.runs[0].approvals, 1);

    const decided = await (await call("/api/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ id: pending.id, decision: "approve", actor: "maintainer" }),
    })).json();
    assert.equal(decided.status, "approved");
    assert.equal(decided.decidedBy, "ui:maintainer");

    // Deciding twice is a conflict, not a silent overwrite.
    const again = await call("/api/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ id: pending.id, decision: "reject" }),
    });
    assert.equal(again.status, 409);
    assert.equal((await (await call("/api/state")).json()).approvals.pending.length, 0);
  } finally {
    await review.close();
  }
});

test("the review UI refuses requests without its token", async () => {
  const root = await createProject();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-etnpilot-token": "wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    // A cross-origin page cannot get a preflight answered.
    assert.equal((await fetch(`${base}/api/approvals/decide`, { method: "OPTIONS" })).status, 405);

    const page = await fetch(`${base}/?token=${review.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    const body = await page.text();
    assert.match(body, /ETNPilot Review/);
    // The page loads nothing from anywhere else.
    // Nothing is loaded from anywhere; the SVG namespace is a name, not an
    // address, and the icon is a data: URI the policy allows.
    assert.deepEqual(
      (body.match(/https?:\/\/[^"'\s)]+/g) ?? []).filter((address) => !address.startsWith("http://www.w3.org/2000/svg")),
      [],
    );
    assert.match(page.headers.get("content-security-policy"), /img-src data:/);
    assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  } finally {
    await review.close();
  }
});

test("the review UI validates what it is asked to decide", async () => {
  const root = await createProject();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const call = (body) => fetch(`http://127.0.0.1:${address.port}/api/approvals/decide`, {
      method: "POST",
      headers: { "x-etnpilot-token": review.token, "content-type": "application/json" },
      body,
    });

    assert.equal((await call(JSON.stringify({ id: "x", decision: "maybe" }))).status, 400);
    assert.equal((await call(JSON.stringify({ decision: "approve" }))).status, 400);
    assert.equal((await call("not json")).status, 400);
    assert.equal((await call(JSON.stringify({ id: "unknown-id", decision: "approve" }))).status, 409);
  } finally {
    await review.close();
  }
});

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  const store = new JsonlReceiptStore(join(root, ".etnpilot", "state", "runs", "20260101000000-abcd1234.jsonl"));
  await store.append({
    type: "agent",
    runId: "run-9",
    status: "succeeded",
    approvals: [{
      operationKind: "write",
      decision: "approve-once",
      at: new Date().toISOString(),
      evidence: { decidedBy: "ui:maintainer" },
    }],
  });
  await store.append({
    type: "workflow",
    terminal: true,
    runId: "run-9",
    status: "succeeded",
    durationMs: 1200,
    workspace: { branch: "etnpilot/run-9", sandbox: { image: "node:24-bookworm-slim" } },
    git: { mergeRehearsal: { clean: true, targetBranch: "main" } },
    settings: { layers: [{ source: "project" }, { source: "user-local" }], overrides: ["queue.workers"] },
  });
  return root;
}

test("a failed queue job is resumed from the page, and an unknown one is a conflict", async () => {
  const root = await createProject();
  const queue = new WorkflowQueue(join(root, ".etnpilot", "state", "workflows.sqlite"));
  const { job } = queue.enqueue({ kind: "gitlab-issue", payload: { issue: 7 }, maxAttempts: 1 });
  const claimed = queue.claim("worker-1");
  queue.fail(claimed.id, "worker-1", new Error("checks failed"));
  assert.equal(queue.get(job.id).status, "failed");
  queue.close();

  const review = await createReviewServer({ root });
  try {
    const call = await caller(review);
    const resumed = await (await call("/api/queue/resume", { method: "POST", body: JSON.stringify({ id: job.id }) })).json();
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.attempts, 0);
    assert.equal(review.queue.get(job.id).status, "queued");

    // A job that cannot be resumed, and one that does not exist, are both
    // answered as conflicts rather than as a server fault.
    const again = await call("/api/queue/resume", { method: "POST", body: JSON.stringify({ id: job.id }) });
    assert.equal(again.status, 409);
    const unknown = await call("/api/queue/resume", { method: "POST", body: JSON.stringify({ id: "nope" }) });
    assert.equal(unknown.status, 409);
    assert.match((await unknown.json()).error, /Unknown workflow job/);
    assert.equal((await call("/api/queue/resume", { method: "POST", body: JSON.stringify({}) })).status, 400);
  } finally {
    await review.close();
  }
});

test("a run's receipt is served in full, and only from this project's runs", async () => {
  const root = await createProject();
  const review = await createReviewServer({ root });
  try {
    const call = await caller(review);
    const state = await (await call("/api/state")).json();
    const file = state.runs[0].receiptFile;

    const receipt = await (await call(`/api/runs/${encodeURIComponent(file)}`)).json();
    assert.equal(receipt.file, file);
    assert.equal(receipt.entries.length, 2);
    assert.equal(receipt.terminal.status, "succeeded");
    // The evidence a reviewer came for: the branch, the rehearsal, who decided
    // an approval, and which settings were in effect.
    assert.equal(receipt.terminal.workspace.branch, "etnpilot/run-9");
    assert.deepEqual(receipt.terminal.settings.overrides, ["queue.workers"]);
    assert.equal(receipt.entries[0].approvals[0].evidence.decidedBy, "ui:maintainer");

    // A name that is not a receipt file in this project never reaches the
    // disk. An escape written plainly is resolved away by URL parsing before
    // any route sees it, so it is refused as 404; one that survives parsing is
    // refused by readReceipt as 400. Either way nothing outside is read.
    assert.equal((await call("/api/runs/../../etc/passwd")).status, 404);
    for (const bad of ["..%2F..%2Fetc%2Fpasswd", "notes.txt", "runs%2F..%2F..%2Fetc%2Fpasswd"]) {
      const response = await call(`/api/runs/${bad}`);
      assert.equal(response.status, 400, bad);
    }
    assert.equal((await call("/api/runs/20200101000000-absent.jsonl")).status, 404);
  } finally {
    await review.close();
  }
});

test("the page's own script parses, and every view it promises is there", async () => {
  const { renderReviewPage } = await import("../src/ui/page.js");
  const html = renderReviewPage("t0ken");
  for (const section of ["Start a run", "Pending approvals", "Workflow queue", "Runs", "Worktrees", "Merge requests", "Settings"]) {
    assert.match(html, new RegExp(section));
  }
  // Each view has somewhere to render into, or choosing it shows nothing.
  for (const view of ["overview", "approvals", "queue", "runs", "worktrees", "merges", "settings"]) {
    assert.match(html, new RegExp(`id="view-${view}"`), view);
  }
  // A view that is not on screen must be told twice: a display declaration
  // overrides the hidden attribute, which is how they once all stacked up.
  assert.match(html, /\.view\[hidden\] \{ display: none; \}/);
  // A grid child is min-width auto, so the grids that hold content say
  // otherwise — the page has been dragged sideways by one wide table twice.
  assert.equal((html.match(/grid-template-columns: minmax\(0, 1fr\)/g) ?? []).length >= 3, true);
  // A page whose script does not parse shows nothing at all, and no test that
  // only reads the markup would notice.
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "the inline script must parse");
  // It still loads nothing from anywhere. The one remaining http URL is the
  // SVG namespace, which is an identifier rather than an address.
  const addresses = (html.match(/https?:\/\/[^"'\s)]+/g) ?? [])
    .filter((address) => !address.startsWith("http://www.w3.org/2000/svg"))
    .filter((address) => !address.startsWith("http://127.0.0.1"));
  assert.deepEqual(addresses, []);
});

test("the worktrees and the merge requests are on the page too", async () => {
  const root = await createProject();
  const review = await createReviewServer({ root });
  try {
    const call = await caller(review);
    // The fixture project is not a git checkout, so the answer says that
    // rather than looking like a project with no worktrees.
    const worktrees = await (await call("/api/worktrees")).json();
    assert.equal(worktrees.available, false);
    assert.match(worktrees.error, /not a git repository/);
    assert.equal((await call("/api/worktrees/remove", { method: "POST", body: JSON.stringify({ name: "../escape" }) })).status, 400);

    const merges = await (await call("/api/merges")).json();
    assert.equal(merges.configured, false);
    assert.match(merges.reason, /git\.project/);
  } finally {
    await review.close();
  }
});

// One authenticated caller, since every test needs the same two headers.
async function caller(review) {
  const address = await review.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  return (path, options = {}) => fetch(base + path, {
    ...options,
    headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
}

test("a port open to the network is named as such, with an address that works there", async () => {
  const root = await createProject();
  const loopback = await createReviewServer({ root });
  try {
    const address = await loopback.listen({ port: 0 });
    assert.equal(address.exposed, false);
    assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  } finally {
    await loopback.close();
  }

  const shared = await createReviewServer({ root });
  try {
    const address = await shared.listen({ host: "0.0.0.0", port: 0 });
    // The link has to be one the other device can reach, and the caller has
    // to be told the loopback guarantee no longer holds.
    assert.equal(address.exposed, true);
    assert.doesNotMatch(address.url, /127\.0\.0\.1/);
    assert.match(address.url, /^http:\/\/[^/]+:\d+\/\?token=/);
    // It is the same server either way: the token still decides everything.
    const base = address.url.slice(0, address.url.indexOf("/?token="));
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-etnpilot-token": shared.token } })).status, 200);
  } finally {
    await shared.close();
  }
});

test("a provider's live models reach the page, and a provider with no key says why not", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-models-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "providers:",
    "  openai:",
    "    type: openai-compatible",
    "    baseUrl: https://api.openai.example/v1",
    "    apiKeySecret: openai.apiKey",
    "  local-copilot:",
    "    type: github-copilot",
    "secrets:",
    "  providers:",
    "    env: { type: env, allow: [OPENAI_TEST_KEY] }",
    "  values:",
    "    openai.apiKey: { provider: env, key: OPENAI_TEST_KEY }",
    "",
  ].join("\n"));

  const review = await createReviewServer({ root, env: { ...process.env, OPENAI_TEST_KEY: "sk-live-test" } });
  const originalFetch = globalThis.fetch;
  let seenAuth;
  globalThis.fetch = async (url, options) => {
    // The test's own calls to the local review server share this same global
    // with the provider call listModels() makes; only the latter is stubbed.
    if (String(url).startsWith("http://127.0.0.1")) return originalFetch(url, options);
    seenAuth = options.headers.authorization;
    assert.equal(url, "https://api.openai.example/v1/models");
    return new Response(JSON.stringify({
      data: [
        { id: "gpt-5", owned_by: "openai" },
        { id: "text-embedding-3-large", owned_by: "openai" },
      ],
    }), { status: 200 });
  };
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const call = (path) => fetch(base + path, { headers: { "x-etnpilot-token": review.token } });

    const openai = await (await call("/api/providers/openai/models")).json();
    assert.equal(seenAuth, "Bearer sk-live-test");
    assert.equal(openai.available, true);
    // Only the chat-capable one reached the page.
    assert.deepEqual(openai.models.map((m) => m.id), ["gpt-5"]);
    // OpenAI has no known-price entry: honest about it, not a guessed number.
    assert.equal(openai.models[0].knownPrice, undefined);

    // A provider type with no models endpoint says so by name.
    const copilot = await (await call("/api/providers/local-copilot/models")).json();
    assert.equal(copilot.available, false);
    assert.match(copilot.reason, /github-copilot.*no models endpoint/);

    // A provider that does not exist is a bad request, not a server fault.
    const missing = await call("/api/providers/nope/models");
    assert.equal(missing.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
    await review.close();
  }
});

test("a known Anthropic price rides along with its model", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-anthropic-models-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "providers:",
    "  claude:",
    "    type: anthropic",
    "secrets:",
    "  providers:",
    "    env: { type: env, allow: [ANTHROPIC_TEST_KEY] }",
    "  values:",
    "    anthropic.apiKey: { provider: env, key: ANTHROPIC_TEST_KEY }",
    "",
  ].join("\n"));
  const review = await createReviewServer({ root, env: { ...process.env, ANTHROPIC_TEST_KEY: "sk-ant-test" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("http://127.0.0.1")) return originalFetch(url, options);
    return new Response(JSON.stringify({
      data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
    }), { status: 200 });
  };
  try {
    const address = await review.listen({ port: 0 });
    const call = (path) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { "x-etnpilot-token": review.token } });
    const result = await (await call("/api/providers/claude/models")).json();
    assert.equal(result.models[0].knownPrice.inputPerMillion, 5);
    assert.match(result.models[0].knownPrice.source, /anthropic\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    await review.close();
  }
});
