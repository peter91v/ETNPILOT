import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function acquireWorkspaceLease(root, { sessionId } = /** @type {any} */ ({})) {
  const directory = join(root, ".etnpilot", "state");
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "workspace-lease.sqlite"));
  database.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, session TEXT, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);");
  const owner = randomUUID();
  try {
    const result = database.prepare("INSERT OR IGNORE INTO workspace_lease VALUES (1, ?, ?, ?, ?)").run(owner, sessionId ?? null, process.pid, new Date().toISOString());
    if (result.changes !== 1) {
      const row = database.prepare("SELECT * FROM workspace_lease WHERE id=1").get();
      const error = new Error(`The workspace is leased by ${row.owner}${row.session ? ` (conversation ${row.session})` : ""}. Wait or stop its run. After a crash, review the workspace and recover the lease explicitly.`);
      error.code = "workspace_busy"; error.statusCode = 409; error.lease = { ...row }; throw error;
    }
  } catch (error) { database.close(); throw error; }
  let released = false;
  return { owner, release() {
    if (released) return;
    released = true;
    try { database.prepare("DELETE FROM workspace_lease WHERE id=1 AND owner=?").run(owner); }
    finally { database.close(); }
  } };
}

// Recovery never silently reruns an orphaned operation. The caller must name
// the owner observed after reviewing the workspace and stopping its processes.
export async function recoverWorkspaceLease(root, owner) {
  if (typeof owner !== "string" || !/^[a-f0-9-]{36}$/.test(owner)) throw new TypeError("Recovery requires the exact lease owner UUID.");
  const database = new DatabaseSync(join(root, ".etnpilot", "state", "workspace-lease.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout=5000;");
    const row = database.prepare("SELECT * FROM workspace_lease WHERE id=1 AND owner=?").get(owner);
    if (!row) throw new Error("The lease owner changed or the lease was already released.");
    try { process.kill(row.pid, 0); throw new Error("The lease owner's process is still running; stop it before recovery."); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    database.prepare("DELETE FROM workspace_lease WHERE id=1 AND owner=?").run(owner);
    return { recovered: true, owner };
  } finally { database.close(); }
}
