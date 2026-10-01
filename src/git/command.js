import { runChild } from "../runtime/child-process.js";

// 'trim' is the default because most callers want a value, not a line; it is
// off where a column matters, such as the two status columns of
// 'git status --porcelain', whose first one is a space for an unstaged change.
export function git(args, { cwd, env = process.env, input, allowExitCodes = [], trim = true, signal, timeoutMs = 120_000, outputLimit = 4 * 1024 * 1024 } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Git arguments must be an array of strings.");
  }
  return runChild(["git", ...args], { cwd, env, input, signal, timeoutMs, outputLimit }).then((result) => {
    if (!result.timedOut && !result.truncated && (result.exitCode === 0 || allowExitCodes.includes(result.exitCode))) {
      return { stdout: trim ? result.stdout.trim() : result.stdout, stderr: result.stderr.trim(), exitCode: result.exitCode };
    }
    throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.timedOut ? "timeout" : result.truncated ? "output limit exceeded" : result.stderr.trim()}`);
  });
}
