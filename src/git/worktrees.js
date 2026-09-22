import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { git } from "./command.js";

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

  async removeIfClean(name) {
    assertRef(name, "worktree name");
    const path = this.#path(name);
    const status = await git(["status", "--porcelain"], { cwd: path });
    if (status.stdout) {
      return { removed: false, name, path, reason: "dirty-worktree", status: status.stdout };
    }
    await git(["worktree", "remove", path], { cwd: this.repositoryRoot });
    await git(["worktree", "prune"], { cwd: this.repositoryRoot });
    return { removed: true, name, path };
  }

  #path(name) {
    const path = resolve(this.worktreeRoot, name);
    if (!path.startsWith(`${this.worktreeRoot}${sep}`)) throw new Error("Worktree path escapes its root.");
    return path;
  }
}

function assertRef(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..")) {
    throw new TypeError(`Invalid ${label}: '${value}'.`);
  }
}
