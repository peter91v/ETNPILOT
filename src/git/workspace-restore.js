// @ts-check
import { git } from "./command.js";
import { workspaceDigest } from "./workspace-digest.js";

// Puts a working tree back to a state a workspace digest named. The digest's
// tree was written into git's object store when it was taken (that is how it
// has a name), so it is still there to go back to: tracked changes, and files
// the step created that git would have added.
//
// What it discards is what the digests differ by, and it says so first
// (describeRestore). It never leaves the worktree's branch, and it leaves
// ignored files alone.

/** @param {string} digest 'git:<head>:<tree>' */
export function parseDigest(digest) {
  const match = /^git:([0-9a-f]{7,64}):([0-9a-f]{7,64})$/.exec(String(digest ?? ""));
  return match ? { head: match[1], tree: match[2] } : undefined;
}

/**
 * What going back to `digest` would change: files that exist now and did not
 * then (they would be removed), files that differ (they would be put back as
 * they were), and files that are gone now (they would come back).
 * @returns {Promise<{ files: Array<{ status: "removed" | "reverted" | "restored", path: string }>, now: string } | { unavailable: string }>}
 */
export async function describeRestore(cwd, digest) {
  const wanted = parseDigest(digest);
  if (!wanted) return { unavailable: "the recorded workspace state is not a git tree" };
  const now = await workspaceDigest(cwd);
  if (now.unavailable) return { unavailable: now.unavailable };
  if (now.head !== wanted.head) return { unavailable: `the worktree's HEAD moved (${wanted.head.slice(0, 8)} then, ${now.head.slice(0, 8)} now)` };
  const listing = (await git(["diff-tree", "-r", "--no-renames", "--name-status", wanted.tree, now.tree], { cwd })).stdout;
  const files = listing.split("\n").filter(Boolean).map((line) => {
    const [code, ...rest] = line.split("\t");
    // diff-tree goes from the recorded tree to the current one: an 'A' is
    // something added since, a 'D' something deleted since.
    return /** @type {{ status: "removed" | "reverted" | "restored", path: string }} */ ({ status: code === "A" ? "removed" : code === "D" ? "restored" : "reverted", path: rest.join("\t") });
  });
  return { files, now: String(now.digest) };
}

/** @returns {Promise<void>} */
export async function restoreWorkspace(cwd, digest) {
  const wanted = parseDigest(digest);
  if (!wanted) throw new Error("The recorded workspace state is not a git tree, so there is nothing to go back to.");
  const before = await workspaceDigest(cwd);
  if (before.unavailable) throw new Error(`The worktree cannot be read (${before.unavailable}).`);
  if (before.head !== wanted.head) throw new Error(`The worktree's HEAD moved since the step finished (${wanted.head.slice(0, 8)} then, ${before.head.slice(0, 8)} now); going back across a commit is not done.`);
  // The index and the files take the recorded tree; files git does not know
  // and that are not in the tree go; the index goes back to HEAD so that the
  // work shows as changes again, the way the step left it.
  await git(["read-tree", "--reset", "-u", wanted.tree], { cwd });
  await git(["clean", "-fdq"], { cwd });
  await git(["reset", "-q"], { cwd });
  const after = await workspaceDigest(cwd);
  if (after.digest !== digest) throw new Error(`Going back did not give the recorded state (${digest} wanted, ${after.digest ?? after.unavailable} now).`);
}
