import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeProject } from "../src/config/init.js";
import { createReviewServer } from "../src/ui/server.js";

// The page edits settings against the same layers the CLI and the TUI use, so
// it must be refused for the same reasons — and say so where the change was
// made rather than as a failed request.
test("settings are listed with their layer, their mode, and what a reset would restore", async () => {
  const { call, close } = await settingsServer();
  try {
    const settings = await (await call("/api/settings")).json();
    const byPath = Object.fromEntries(settings.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath["queue.workers"].source, "project");
    assert.equal(byPath["queue.workers"].mode, "open");
    assert.equal(byPath["approval.allow"].mode, "stricter-only");
    assert.deepEqual(byPath["approval.allow"].value, ["read"]);
    assert.deepEqual(byPath["approval.allow"].defaultValue, ["read"]);
    // Only the layers that exist are listed; a project with no local file has
    // just the committed one.
    assert.deepEqual(settings.layers.map((layer) => layer.source), ["project"]);
    assert.deepEqual(settings.overrides, []);
    assert.deepEqual(settings.refusals, []);
  } finally {
    await close();
  }
});

test("an open setting is changed locally, and never committed", async () => {
  const { call, close, root, committed } = await settingsServer();
  try {
    const result = await (await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "queue.workers", value: "3", scope: "local" }),
    })).json();
    assert.equal(result.effective, 3);
    assert.equal(result.scope, "local");
    assert.equal(result.mode, "open");

    const local = await readFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "utf8");
    assert.match(local, /workers: 3/);
    // The committed file is untouched: a local change is never committed.
    assert.doesNotMatch(await readFile(committed, "utf8"), /workers: 3/);
    const after = await (await call("/api/settings")).json();
    assert.deepEqual(after.layers.map((layer) => layer.source), ["project", "user-local"]);
    assert.equal(after.entries.find((entry) => entry.path === "queue.workers").source, "user-local");

    // The state the page polls says which settings a person changed, so a run
    // can be read against the configuration it actually used.
    const state = await (await call("/api/state")).json();
    assert.deepEqual(state.settings.overrides, ["queue.workers"]);

    const reset = await (await call("/api/settings/unset", {
      method: "POST",
      body: JSON.stringify({ path: "queue.workers", scope: "local" }),
    })).json();
    // Back to what the committed file says, not to a value the page invented.
    assert.equal(reset.effective, (await (await call("/api/settings")).json())
      .entries.find((entry) => entry.path === "queue.workers").defaultValue);
    assert.deepEqual((await (await call("/api/settings")).json()).overrides, []);
  } finally {
    await close();
  }
});

test("narrowing is allowed, widening and locked settings are refused as conflicts", async () => {
  const { call, close } = await settingsServer();
  try {
    // 'stricter-only' means entries may be removed, never added.
    const narrowed = await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "approval.allow", value: "[]" }),
    });
    assert.equal(narrowed.status, 200);
    assert.deepEqual((await narrowed.json()).effective, []);

    const widened = await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "approval.allow", value: '["read","write"]' }),
    });
    assert.equal(widened.status, 409, "a widening change is a refusal, not a server fault");
    const refusal = await widened.json();
    assert.equal(refusal.path, "approval.allow");
    assert.match(refusal.reason, /may only be removed/);
    assert.match(refusal.error, /Cannot change 'approval.allow'/);

    const locked = await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "secrets.values", value: "{}" }),
    });
    assert.equal(locked.status, 409);
    assert.match((await locked.json()).reason, /locks this setting|only change/);

    // Text that is not YAML is the person's mistake, reported as such.
    const broken = await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "queue.workers", value: "[1, 2" }),
    });
    assert.equal(broken.status, 400);
    assert.match((await broken.json()).error, /not valid YAML/);

    for (const body of [{ value: "1" }, { path: "queue.workers", value: "1", scope: "elsewhere" }]) {
      assert.equal((await call("/api/settings/set", { method: "POST", body: JSON.stringify(body) })).status, 400);
    }
  } finally {
    await close();
  }
});

test("a refused local file is reported above the list rather than hiding the page", async () => {
  const { call, close, root } = await settingsServer();
  try {
    const { writeFile } = await import("node:fs/promises");
    // A setting the committed default locks cannot be changed locally at all,
    // and a run will not start until it is gone.
    await writeFile(join(root, ".etnpilot", "etnpilot.local.yaml"), "secrets:\n  values:\n    token: hunter2\n");
    const settings = await (await call("/api/settings")).json();
    assert.equal(settings.refusals.length, 1);
    assert.match(settings.refusals[0].path, /^secrets/);

    // The rest of the page still works: approvals and runs are unaffected.
    const state = await (await call("/api/state")).json();
    assert.ok(Array.isArray(state.runs));
    assert.equal(state.settings.refusals.length, 1);
  } finally {
    await close();
  }
});

async function settingsServer() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-settings-"));
  await initializeProject(root);
  const env = { ...process.env, ETNPILOT_CONFIG_HOME: join(root, "config-home") };
  const review = await createReviewServer({ root, env });
  const address = await review.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  return {
    root,
    committed: join(root, ".etnpilot", "etnpilot.yaml"),
    call: (path, options = {}) => fetch(base + path, {
      ...options,
      headers: { "x-etnpilot-token": review.token, ...(options.body ? { "content-type": "application/json" } : {}) },
    }),
    close: () => review.close(),
  };
}

test("the values a setting accepts are part of what the page is told", async () => {
  const { call, close } = await settingsServer();
  try {
    const settings = await (await call("/api/settings")).json();
    const byPath = Object.fromEntries(settings.entries.map((entry) => [entry.path, entry]));
    // The page builds its dropdowns and checkboxes from this, so it is here
    // rather than in the page's own copy of what a setting accepts.
    assert.deepEqual(byPath["workspace.mode"].choices, { kind: "one", values: ["worktree", "in-place"] });
    assert.deepEqual(byPath["approval.requireHuman"].choices.kind, "set");
    assert.equal(byPath["git.committer.name"].choices, undefined);

    // Choosing in a row is the same call as saving in the editor.
    const chosen = await (await call("/api/settings/set", {
      method: "POST",
      body: JSON.stringify({ path: "workspace.mode", value: '"in-place"', scope: "local" }),
    })).json();
    assert.equal(chosen.effective, "in-place");
  } finally {
    await close();
  }
});
