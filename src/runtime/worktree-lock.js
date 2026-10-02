// @ts-check
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// One run at a time in a worktree that is being continued. Two runs editing the
// same files would each be sure the files are as they left them. The lock is a
// small file, made with exclusive creation, that names the process holding it;
// one whose process is gone (or that is older than a day) is stale and taken
// over, because a run that was killed must not lock its own worktree for good.

const STALE_AFTER_MS = 24 * 60 * 60_000;

function lockPath(root, workspacePath) {
  const key = createHash("sha256").update(resolve(workspacePath)).digest("hex").slice(0, 24);
  return join(resolve(root), ".etnpilot", "state", "locks", `worktree-${key}.lock`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Who holds it now, or undefined when nobody does (no file, or a stale one).
export async function worktreeLockHolder(root, workspacePath, { now = Date.now() } = /** @type {any} */ ({})) {
  const text = await readFile(lockPath(root, workspacePath), "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  let holder;
  try {
    holder = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(holder?.pid) || !alive(holder.pid)) return undefined;
  if (now - Date.parse(holder.since) > STALE_AFTER_MS) return undefined;
  return holder;
}

export async function acquireWorktreeLock(root, workspacePath, { label } = /** @type {any} */ ({})) {
  const path = lockPath(root, workspacePath);
  await mkdir(join(path, ".."), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), ...(label ? { label } : {}) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, body, { flag: "wx", mode: 0o600 });
      return { path, release: () => rm(path, { force: true }) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = await worktreeLockHolder(root, workspacePath);
      if (holder) {
        const busy = new Error(`Another run is working in this worktree (process ${holder.pid}, since ${holder.since}${holder.label ? `, ${holder.label}` : ""}). Wait for it, or stop it.`);
        /** @type {any} */ (busy).code = "worktree_busy";
        throw busy;
      }
      // Stale: its process is gone. Remove it and try once more.
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not take the worktree lock.");
}
