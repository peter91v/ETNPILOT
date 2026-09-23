import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReviewServer } from "../src/ui/server.js";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";

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
    assert.doesNotMatch(body, /https?:\/\/(?!127\.0\.0\.1)/);
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
    approvals: [{ operationKind: "write", decision: "approve-once", at: new Date().toISOString() }],
  });
  await store.append({ type: "workflow", terminal: true, runId: "run-9", status: "succeeded", durationMs: 1200 });
  return root;
}
