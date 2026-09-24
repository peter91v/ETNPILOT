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

  // What a worktree is actually holding. The surfaces ask for this when a
  // person opens one, so 'it keeps unsaved work' can be read as a list of
  // files rather than as a number they have to take on trust.
  async changesAt(path, { ignoredUntracked = DEFAULT_IGNORED_UNTRACKED, limit = 500 } = {}) {
    // Untrimmed: the first of the two status columns is a space for a change
    // that is not staged, and trimming it would shift every path by one.
    const status = await git(["status", "--porcelain"], { cwd: path, trim: false });
    const lines = status.stdout.split("\n").filter(Boolean);
    const entries = lines.slice(0, limit).map((line) => {
      const index = line[0];
      const worktree = line[1];
      const rest = line.slice(3);
      // A rename is recorded as 'old -> new'; the new name is the file now.
      const [from, to] = rest.includes(" -> ") ? rest.split(" -> ") : [undefined, rest];
      return {
        path: unquote(to),
        ...(from ? { renamedFrom: unquote(from) } : {}),
        index: index === " " ? undefined : index,
        worktree: worktree === " " ? undefined : worktree,
        label: describeStatus(index, worktree),
        // The artifacts ETNPilot writes into a workspace are listed, but
        // marked, because they are not a person's unsaved work.
        ignorable: isIgnorableUntracked(line, ignoredUntracked),
      };
    });
    return {
      path,
      entries,
      total: lines.length,
      blocking: lines.filter((line) => !isIgnorableUntracked(line, ignoredUntracked)).length,
      ...(lines.length > entries.length ? { truncated: lines.length } : {}),
    };
  }

  async changes(name, options = {}) {
    assertRef(name, "worktree name");
    return this.changesAt(this.#path(name), options);
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

const STATUS_LABELS = Object.freeze({
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  T: "type changed",
  "?": "untracked",
  "!": "ignored",
});

function describeStatus(index, worktree) {
  if (index === "?" || worktree === "?") return "untracked";
  const staged = index && index !== " " ? STATUS_LABELS[index] ?? index : undefined;
  const unstaged = worktree && worktree !== " " ? STATUS_LABELS[worktree] ?? worktree : undefined;
  if (staged && unstaged && staged !== unstaged) return `${staged}, then ${unstaged}`;
  return staged ?? unstaged ?? "changed";
}

// git quotes a path that contains unusual characters; the quotes are the
// report's, not the file's.
function unquote(value) {
  return value.replace(/^"(.*)"$/, "$1");
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
