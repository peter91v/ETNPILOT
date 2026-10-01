// @ts-check
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readHandle } from "./bounded-io.js";

const DIRECTORY = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const FILE = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
export const digestBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Directory descriptors keep path traversal anchored while an approval waits.
// Platforms without a directory-descriptor namespace fail closed for writes.
export async function workspaceFile(root, name, { maxBytes, missing = false, truncate = false, directory = false } = /** @type {any} */ ({})) {
  const workspace = await realpath(root);
  const destination = resolve(workspace, name);
  const local = relative(workspace, destination);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Path leaves the workspace or names its root.");
  const parts = local.split(sep);
  const leaf = parts.pop();
  const handles = [];
  const parents = [];
  let parentPath = workspace;
  let parent;
  let anchor;
  let remaining = [];
  try {
    parent = await open(workspace, DIRECTORY);
    handles.push(parent);
    parents.push({ path: workspace, details: await parent.stat() });
    for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
      const candidate = `${prefix}/${parent.fd}`;
      const details = await lstat(`${candidate}/.`).catch(() => undefined);
      if (same(details, parents[0].details)) { anchor = prefix; break; }
    }
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const nextPath = join(parentPath, part);
      const named = await lstat(nextPath).catch((error) => {
        if (missing && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!named) { remaining = parts.slice(index); break; }
      if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("Workspace parent must be a directory without symlinks.");
      const next = await open(anchor ? `${anchor}/${parent.fd}/${part}` : nextPath, DIRECTORY);
      handles.push(next);
      if (!same(named, await next.stat())) throw new Error("Workspace parent changed while opening it.");
      parent = next;
      parentPath = nextPath;
      parents.push({ path: nextPath, details: named });
    }
    const source = () => anchor ? `${anchor}/${parent.fd}/${leaf}` : join(/** @type {string} */ (parentPath), /** @type {string} */ (leaf));
    async function assertParents() {
      for (const entry of parents) {
        const now = await lstat(entry.path);
        if (now.isSymbolicLink() || !same(now, entry.details)) throw new Error("Workspace parent changed; request a new approval.");
      }
    }
    async function snapshot() {
      if (remaining.length) return { bytes: undefined, details: undefined };
      await assertParents();
      const handle = await open(source(), constants.O_RDONLY | FILE).catch((error) => {
        if (missing && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!handle) return { bytes: undefined, details: undefined };
      try {
        const details = await handle.stat();
        if (details.nlink > 1) throw new Error("Hard-linked workspace files are not supported.");
        const named = await lstat(join(/** @type {string} */ (parentPath), /** @type {string} */ (leaf)));
        if (named.isSymbolicLink() || !same(named, details)) throw new Error("Workspace file changed while opening it.");
        const bytes = await readHandle(handle, maxBytes, { truncate });
        const after = await handle.stat();
        if (details.size !== after.size || details.mtimeMs !== after.mtimeMs) throw new Error("Workspace file changed while reading it.");
        await assertParents();
        return { bytes, details };
      } finally { await handle.close(); }
    }
    const before = directory ? { bytes: undefined, details: undefined } : await snapshot();
    return {
      ...before,
      async list({ maxEntries, maxBytes }) {
        if (remaining.length) throw new Error("Directory does not exist.");
        await assertParents();
        const directory = await opendir(anchor ? `${anchor}/${parent.fd}/.` : parentPath);
        const entries = [];
        let bytes = 0;
        let truncated = false;
        for await (const entry of directory) {
          const size = Buffer.byteLength(entry.name) + 2;
          if (entries.length >= maxEntries || bytes + size > maxBytes) { truncated = true; break; }
          entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
          bytes += size;
        }
        await assertParents();
        return { entries, truncated };
      },
      async remove() {
        if (!anchor || before.bytes === undefined) throw new Error("Secure removal requires an existing anchored file.");
        const current = await snapshot();
        if (!same(current.details, before.details) || !/** @type {Buffer} */ (current.bytes).equals(before.bytes)) throw new Error("Workspace file changed; request a new approval.");
        await assertParents();
        await unlink(source());
      },
      async write(bytes) {
        if (directory) throw new Error("Directory handles cannot write files.");
        if (bytes.length > maxBytes) throw new Error("Write byte limit exceeded.");
        if (!anchor) throw new Error("Secure workspace writes require directory-descriptor access on this platform.");
        await assertParents();
        for (const part of remaining) {
          const path = `${anchor}/${parent.fd}/${part}`;
          await mkdir(path).catch((error) => { if (error.code !== "EEXIST") throw error; });
          const next = await open(path, DIRECTORY);
          handles.push(next);
          parent = next;
          parentPath = join(parentPath, part);
          parents.push({ path: parentPath, details: await next.stat() });
        }
        remaining = [];
        await assertParents();
        const flags = before.bytes === undefined
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE
          : constants.O_RDWR | FILE;
        const handle = await open(source(), flags, 0o666);
        try {
          const details = await handle.stat();
          if (!details.isFile() || details.nlink > 1) throw new Error("Not a regular, singly linked file.");
          if (before.bytes !== undefined) {
            if (!same(before.details, details)) throw new Error("Workspace file changed; request a new approval.");
            const now = await readHandle(handle, maxBytes);
            if (!now.equals(before.bytes)) throw new Error("Workspace file changed; request a new approval.");
          }
          await assertParents();
          await handle.truncate(0);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        return { path: local.split(sep).join("/"), before: before.bytes === undefined ? null : digestBytes(before.bytes), after: digestBytes(bytes) };
      },
      close: async () => { for (const handle of handles.reverse()) await handle.close().catch(() => {}); },
    };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
    throw error;
  }
}
