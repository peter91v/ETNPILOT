import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { acquireWorkspaceLease } from "../src/runtime/workspace-lease.js";
import { WorkflowQueue } from "../src/workflow/queue.js";

// node:sqlite is still marked experimental, and the databases are on people's
// phones, written by one version and read by the next. The shape of each is
// pinned here: a change to a table or index fails this test until the golden
// file is updated on purpose, and a changed table needs a migration (see
// ensureColumn in src/core/approval-inbox.js) so an existing database keeps
// working. Update with: UPDATE_GOLDEN=1 node --test test/sqlite-schema.test.js

const golden = new URL("./golden/sqlite-schema.json", import.meta.url);

function shape(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .map((row) => ({ type: row.type, name: row.name, sql: String(row.sql).replace(/\s+/g, " ").trim() }));
  } finally {
    database.close();
  }
}

test("the databases have the shape they are pinned to", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-schema-"));
  const inboxPath = join(root, "inbox.sqlite");
  const queuePath = join(root, "queue.sqlite");
  new ApprovalInbox(inboxPath).close();
  new WorkflowQueue(queuePath).close();
  const lease = await acquireWorkspaceLease(root);
  await lease.release();
  const actual = {
    approvals: shape(inboxPath),
    queue: shape(queuePath),
    lease: shape(join(root, ".etnpilot", "state", "workspace-lease.sqlite")),
  };
  if (process.env.UPDATE_GOLDEN) {
    await writeFile(golden, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(await readFile(golden, "utf8"));
  assert.deepEqual(actual, expected, "A database changed shape. If that is intended, add a migration for existing databases, then run: UPDATE_GOLDEN=1 node --test test/sqlite-schema.test.js");
});

test("a database made by an earlier version is opened and brought up to date", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-schema-old-"));
  const path = join(root, "inbox.sqlite");
  // The first shape of the table, before the columns that were added later.
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, run_id TEXT, agent TEXT, operation_kind TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, reason TEXT, service_instance_id TEXT);");
  old.exec("INSERT INTO approvals VALUES ('a1', 'pending', 'r', 'agent', 'shell', '{}', 1, 2, NULL, NULL, NULL, NULL);");
  old.close();
  const inbox = new ApprovalInbox(path);
  try {
    const columns = new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA table_info(approvals)").all().map((column) => column.name);
    for (const added of ["workflow_job_id", "policy_json", "scope"]) assert.ok(columns.includes(added), `${added} was not added`);
    assert.equal(inbox.get("a1")?.id, "a1");
  } finally {
    inbox.close();
  }
});
