import { spawn } from "node:child_process";

export function git(args, { cwd, env = process.env, input } = {}) {
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
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
