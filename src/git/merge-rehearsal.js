import { git } from "./command.js";

// Publishing a branch that cannot merge wastes a review cycle. A rehearsal
// answers the question before the merge request exists, without touching the
// working tree: git merge-tree computes the merge in memory.
export async function rehearseMerge({
  cwd,
  remote,
  targetBranch = "main",
  fetch = true,
  head = "HEAD",
} = {}) {
  if (!cwd) throw new TypeError("A merge rehearsal requires a working directory.");
  let target = `refs/remotes/${remote}/${targetBranch}`;
  if (fetch && remote) {
    try {
      await git(["fetch", "--quiet", remote, targetBranch], { cwd });
      target = "FETCH_HEAD";
    } catch (error) {
      return { rehearsed: false, reason: "fetch-failed", error: error.message, targetBranch };
    }
  } else if (!remote) {
    target = targetBranch;
  }

  let result;
  try {
    result = await git(["merge-tree", "--write-tree", "--name-only", head, target], {
      cwd,
      allowExitCodes: [1],
    });
  } catch (error) {
    return { rehearsed: false, reason: "merge-tree-unavailable", error: error.message, targetBranch };
  }

  const [tree, ...rest] = result.stdout.split("\n");
  if (result.exitCode === 0) {
    return { rehearsed: true, clean: true, targetBranch, tree, conflicts: [] };
  }
  // On conflict the first line is the tree, then the conflicted paths, then
  // an informational block separated by a blank line.
  const conflicts = [];
  for (const line of rest) {
    if (line.trim() === "") break;
    conflicts.push(line.trim());
  }
  return { rehearsed: true, clean: false, targetBranch, tree, conflicts };
}
