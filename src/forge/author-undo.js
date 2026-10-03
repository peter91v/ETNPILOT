// @ts-check
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// What the authoring wizard wrote, kept so the last thing can be taken back.
// A record holds, for every file, what it was (null when the wizard made it)
// and what the wizard wrote. Undoing puts the old content back only where the
// file still holds what the wizard wrote: a file somebody changed since is
// theirs, and the whole undo is refused rather than half done.
//
// Kept under .etnpilot/state/, which the generated .gitignore excludes.

const KEEP = 20;
const TREES = ["agents", "prompts", "skills", "instructions"];

function undoFile(root) {
  return join(root, ".etnpilot", "state", "author-undo.json");
}

async function readRecords(root) {
  try {
    const data = JSON.parse(await readFile(undoFile(root), "utf8"));
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
  }
}

async function writeRecords(root, records) {
  const path = undoFile(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
}

// Every file under the content trees, as paths relative to the project root.
export async function listContentFiles(root) {
  const found = new Set();
  for (const tree of TREES) {
    const base = join(root, ".etnpilot", tree);
    // Names relative to the tree; a directory entry is skipped by asking for its file.
    for (const name of await readdir(base, { recursive: true }).catch(() => [])) {
      const path = join(base, String(name));
      if (await readFile(path).then(() => true, () => false)) found.add(relative(root, path));
    }
  }
  return found;
}

export async function recordWrites(root, { label, writes }) {
  if (writes.length === 0) return undefined;
  const records = await readRecords(root);
  const record = { id: `${Date.now().toString(36)}`, at: new Date().toISOString(), label, writes };
  await writeRecords(root, [record, ...records].slice(0, KEEP));
  return record.id;
}

export async function describeLastWrite(root) {
  const [last] = await readRecords(root);
  return last ? { id: last.id, at: last.at, label: last.label, paths: last.writes.map((write) => write.path) } : undefined;
}

// Takes back the newest record. Returns { restored, removed } (paths), or throws
// with code "nothing" / "changed".
export async function undoLastWrite(root) {
  const [last, ...rest] = await readRecords(root);
  if (!last) throw Object.assign(new Error("There is nothing to undo."), { code: "nothing" });
  for (const write of last.writes) {
    const now = await readFile(join(root, write.path), "utf8").catch(() => undefined);
    if (now !== write.after) {
      throw Object.assign(new Error(`${write.path} changed since it was written. Nothing was undone.`), { code: "changed" });
    }
  }
  const restored = [];
  const removed = [];
  for (const write of last.writes) {
    const target = join(root, write.path);
    if (write.before === null) {
      await rm(target, { force: true });
      removed.push(write.path);
      // A skill lives in a folder of its own; take it away if nothing else is in it.
      await rmdir(dirname(target)).catch(() => {});
    } else {
      await writeFile(target, write.before, "utf8");
      restored.push(write.path);
    }
  }
  await writeRecords(root, rest);
  return { restored, removed, label: last.label };
}
