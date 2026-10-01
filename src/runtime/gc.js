// @ts-check
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readLastLine } from "./jsonl.js";

// What a project accumulates and what may be cleared out: finished run
// receipts and rotated telemetry files. Nothing here is removed by default: a
// receipt is the record of what an agent did, and the cost history lives in
// the telemetry archives, so the plan is shown first and only `apply` deletes.
//
// Kept regardless of age: the newest `keep` receipts, any receipt that is not
// sealed (it may belong to a run that is still going, or to one that died and
// is worth looking at), and anything whose name is not ours.

export const DEFAULT_OLDER_THAN_DAYS = 90;
export const DEFAULT_KEEP = 50;

export async function planGc({
  root = process.cwd(),
  olderThanDays = DEFAULT_OLDER_THAN_DAYS,
  keep = DEFAULT_KEEP,
  telemetryFile = ".etnpilot/state/telemetry.jsonl",
  now = Date.now(),
} = /** @type {any} */ ({})) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new TypeError("olderThanDays must be zero or more.");
  if (!Number.isInteger(keep) || keep < 0) throw new TypeError("keep must be a whole number.");
  const cutoff = now - olderThanDays * 86_400_000;
  const candidates = [];
  const kept = { newest: 0, unsealed: 0, young: 0 };

  const runsDirectory = join(resolve(root), ".etnpilot", "state", "runs");
  const files = [];
  for (const name of await readdir(runsDirectory).catch(() => [])) {
    if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) continue;
    const details = await stat(join(runsDirectory, name)).catch(() => undefined);
    if (details?.isFile()) files.push({ path: join(runsDirectory, name), name, bytes: details.size, modified: details.mtimeMs });
  }
  files.sort((left, right) => right.modified - left.modified);
  for (const [index, file] of files.entries()) {
    if (index < keep) { kept.newest += 1; continue; }
    if (file.modified > cutoff) { kept.young += 1; continue; }
    if (!(await isSealed(file.path))) { kept.unsealed += 1; continue; }
    candidates.push({ kind: "receipt", ...file });
  }

  const telemetry = resolve(root, telemetryFile);
  const base = basename(telemetry);
  for (const name of await readdir(dirname(telemetry)).catch(() => [])) {
    if (!name.startsWith(`${base}.`) || !/^\d+$/.test(name.slice(base.length + 1))) continue;
    const path = join(dirname(telemetry), name);
    const details = await stat(path).catch(() => undefined);
    if (details?.isFile() && details.mtimeMs <= cutoff) candidates.push({ kind: "telemetry", path, name, bytes: details.size, modified: details.mtimeMs });
  }

  return {
    olderThanDays,
    keep,
    kept,
    candidates,
    bytes: candidates.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export async function applyGc(plan) {
  const removed = [];
  const failed = [];
  for (const file of plan.candidates) {
    try {
      await unlink(file.path);
      removed.push(file.path);
    } catch (error) {
      failed.push({ path: file.path, reason: error.code ?? error.message });
    }
  }
  return { removed, failed };
}

async function isSealed(path) {
  try {
    const line = await readLastLine(path);
    return line ? JSON.parse(line).terminal === true : false;
  } catch {
    return false;
  }
}
