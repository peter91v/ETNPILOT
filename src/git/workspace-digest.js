// @ts-check
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./command.js";

// A name for the state of a working tree: HEAD plus the tree of everything in
// it that git would add (tracked changes and untracked files that are not
// ignored). Two moments with the same digest have the same files. It is taken
// in a throwaway copy of the index, so the real index, the staging area and
// the working tree are not touched.
//
// Returns { digest, head, tree }, or { unavailable } when the directory is
// not a git working tree or git failed: a missing digest is evidence of its
// own and must never stop a run.
export async function workspaceDigest(cwd) {
  let scratch;
  try {
    const head = (await git(["rev-parse", "HEAD"], { cwd })).stdout;
    const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd })).stdout;
    scratch = await mkdtemp(join(tmpdir(), "etnpilot-digest-"));
    const temporary = join(scratch, "index");
    await copyFile(indexPath, temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    const env = { ...process.env, GIT_INDEX_FILE: temporary };
    await git(["add", "-A"], { cwd, env });
    const tree = (await git(["write-tree"], { cwd, env })).stdout;
    return { digest: `git:${head}:${tree}`, head, tree };
  } catch (error) {
    return { unavailable: String(error.message).split("\n")[0] };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
