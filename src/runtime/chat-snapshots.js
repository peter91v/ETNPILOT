import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../git/command.js";

// Undoing what a turn did to the files.
//
// A turn can write several files. To take it back, the state of the working
// tree is recorded before the turn and after it, as git trees — built in a
// throwaway index, so the person's own staging area is never touched — and
// pinned under refs/etnpilot/ so the objects survive garbage collection.
//
// Undo reverts a file only when it is still exactly what the turn left. If the
// person changed it since, undoing would throw their work away with the agent's,
// so that file is left alone and named. This is the same rule as everywhere
// else in this project: say which of two states it is rather than pick one.

// ETNPilot's own bookkeeping is not the agent's work and changes on its own.
const EXCLUDED = [".etnpilot/state", ".etnpilot/worktrees", ".codegraph"];

export async function isGitWorkTree(root) {
  const result = await git(["rev-parse", "--is-inside-work-tree"], { cwd: root }).catch(() => undefined);
  return result?.stdout === "true";
}

// The tree of everything in the working directory that git would track, as it
// is now. Returns undefined outside a repository.
export async function snapshotTree(root) {
  if (!await isGitWorkTree(root)) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "etnpilot-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
  try {
    const head = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, allowExitCodes: [1] });
    if (head.exitCode === 0) await git(["read-tree", "HEAD"], { cwd: root, env });
    await git(["add", "-A", "--", "."], { cwd: root, env });
    // Taken out afterwards rather than excluded by pathspec: git refuses an
    // exclusion of a path that .gitignore already ignores.
    await git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...EXCLUDED], { cwd: root, env });
    return (await git(["write-tree"], { cwd: root, env })).stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Keeps the trees reachable, under a name that says whose they are.
export async function pinSnapshot(root, tree, name) {
  const commit = (await git([
    "-c", "user.name=ETNPilot", "-c", "user.email=etnpilot@localhost",
    "commit-tree", tree, "-m", `ETNPilot chat snapshot ${name}`,
  ], { cwd: root })).stdout;
  await git(["update-ref", `refs/etnpilot/chat/${name}`, commit], { cwd: root });
}

// What changed between two trees: [{ status: A|M|D, path, before, after }].
export async function diffSnapshots(root, from, to) {
  const raw = await git(["diff-tree", "-r", "--no-renames", "-z", from, to], { cwd: root, trim: false });
  const fields = raw.stdout.split("\0").filter((entry) => entry !== "");
  const changes = [];
  // With -z the output alternates: ':old new sha sha status' then the path.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, , oldSha, newSha, status] = fields[index].slice(1).split(" ");
    changes.push({
      status: status[0],
      path: fields[index + 1],
      before: /^0+$/.test(oldSha) ? undefined : oldSha,
      after: /^0+$/.test(newSha) ? undefined : newSha,
    });
  }
  return changes;
}

