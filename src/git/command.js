import { spawn } from "node:child_process";

// 'trim' is the default because most callers want a value, not a line; it is
// off where a column matters, such as the two status columns of
// 'git status --porcelain', whose first one is a space for an unstaged change.
export function git(args, { cwd, env = process.env, input, allowExitCodes = [], trim = true } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Git arguments must be an array of strings.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      // Some porcelain reports a meaningful result through a non-zero exit,
      // such as merge-tree signalling conflicts.
      if (code === 0 || allowExitCodes.includes(code)) {
        resolve({ stdout: trim ? stdout.trim() : stdout, stderr: stderr.trim(), exitCode: code });
      } else {
        reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
