import { mkdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { git } from "./command.js";

const DEFAULT_IGNORED_UNTRACKED = Object.freeze([".codegraph/", ".etnpilot/state/", ".etnpilot/worktrees/"]);

export class WorktreeManager {
  constructor(repositoryRoot, worktreeRoot = ".etnpilot/worktrees") {
    this.repositoryRoot = resolve(repositoryRoot);
    this.worktreeRoot = resolve(repositoryRoot, worktreeRoot);
  }

  async create({ name, branch, startPoint = "HEAD" }) {
    assertRef(name, "worktree name");
    assertRef(branch, "branch");
    const path = this.#path(name);
    await mkdir(dirname(path), { recursive: true });
    await git(["worktree", "add", "-b", branch, path, startPoint], { cwd: this.repositoryRoot });
    return { name, branch, path };
  }

  async list() {
    const { stdout } = await git(["worktree", "list", "--porcelain"], { cwd: this.repositoryRoot });
    return stdout.split("\n\n").filter(Boolean).map((block) => Object.fromEntries(
      block.split("\n").map((line) => {
        const [key, ...parts] = line.split(" ");
        return [key, parts.join(" ") || true];
      }),
    ));
  }

  // What a surface needs to show a worktree: which branch it holds, whether it
  // is one ETNPilot made, and whether removing it would throw away work. The
  // same ignore list as removeIfClean decides the last one, so the screen and
  // the removal can never disagree about 'clean'.
  async describe({ ignoredUntracked = DEFAULT_IGNORED_UNTRACKED } = {}) {
    const described = [];
    for (const entry of await this.list()) {
      const path = typeof entry.worktree === "string" ? entry.worktree : undefined;
      if (path === undefined) continue;
      const managed = path.startsWith(`${this.worktreeRoot}${sep}`);
      const record = {
        name: managed ? relative(this.worktreeRoot, path) : basename(path),
        path,
        branch: typeof entry.branch === "string" ? entry.branch.replace(/^refs\/heads\//, "") : undefined,
        head: typeof entry.HEAD === "string" ? entry.HEAD : undefined,
        detached: entry.detached !== undefined,
        bare: entry.bare !== undefined,
        locked: entry.locked === undefined ? undefined : (entry.locked === true ? "" : String(entry.locked)),
        prunable: entry.prunable === undefined ? undefined : (entry.prunable === true ? "" : String(entry.prunable)),
        managed,
        main: path === this.repositoryRoot,
      };
      described.push({ ...record, ...await this.#inspect(record, ignoredUntracked) });
    }
    return described;
  }

  async #inspect(record, ignoredUntracked) {
    if (record.bare || record.prunable !== undefined) return { readable: false };
    let status;
    try {
      status = await git(["status", "--porcelain"], { cwd: record.path });
    } catch (error) {
      // A worktree whose directory is gone is still worth listing: 'git
      // worktree prune' is the fix, and the screen should say so.
      return { readable: false, error: error.message };
    }
    const entries = status.stdout.split("\n").filter(Boolean);
    const blocking = entries.filter((entry) => !isIgnorableUntracked(entry, ignoredUntracked));
    return {
      readable: true,
      changes: entries.length,
      blocking: blocking.length,
      // Only a managed worktree that holds nothing unsaved can be removed from
      // a surface; the main checkout is never a candidate.
      removable: record.managed && !record.main && record.locked === undefined && blocking.length === 0,
    };
  }

  async removeIfClean(name, { ignoredUntracked = DEFAULT_IGNORED_UNTRACKED } = {}) {
    assertRef(name, "worktree name");
    const path = this.#path(name);
    const status = await git(["status", "--porcelain"], { cwd: path });
    const entries = status.stdout.split("\n").filter(Boolean);
    // Artifacts ETNPilot itself writes into the workspace, such as the local
    // CodeGraph index, must not make a worktree look like unsaved work.
    const blocking = entries.filter((entry) => !isIgnorableUntracked(entry, ignoredUntracked));
    if (blocking.length > 0) {
      return { removed: false, name, path, reason: "dirty-worktree", status: blocking.join("\n") };
    }
    await git(
      entries.length > 0 ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path],
      { cwd: this.repositoryRoot },
    );
    await git(["worktree", "prune"], { cwd: this.repositoryRoot });
    return { removed: true, name, path };
  }

  async deleteBranch(branch) {
    assertRef(branch, "branch");
    await git(["branch", "-D", branch], { cwd: this.repositoryRoot });
    return { deleted: true, branch };
  }

  #path(name) {
    const path = resolve(this.worktreeRoot, name);
    if (!path.startsWith(`${this.worktreeRoot}${sep}`)) throw new Error("Worktree path escapes its root.");
    return path;
  }
}

function isIgnorableUntracked(entry, ignoredUntracked) {
  if (!entry.startsWith("?? ")) return false;
  const path = entry.slice(3).replace(/^"(.*)"$/, "$1");
  return ignoredUntracked.some((prefix) => path === prefix || path.startsWith(prefix));
}

function assertRef(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..")) {
    throw new TypeError(`Invalid ${label}: '${value}'.`);
  }
}
