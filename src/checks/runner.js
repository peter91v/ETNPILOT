import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export async function runCheck(check, { cwd, signal, env = process.env, outputLimit = DEFAULT_OUTPUT_LIMIT } = {}) {
  const command = normalizeCommand(check.command);
  const startedAt = Date.now();
  const result = await spawnCommand(command, {
    cwd,
    env: { ...env, ...(check.env ?? {}) },
    signal,
    outputLimit,
  });
  return {
    name: check.name ?? command.join(" "),
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    durationMs: Date.now() - startedAt,
  };
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError("Check commands must be non-empty string arrays.");
  }
  return command;
}

function spawnCommand([executable, ...args], { cwd, env, signal, outputLimit }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, signal, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const collect = (target, chunk) => {
      const current = target === "stdout" ? stdout : stderr;
      const room = Math.max(0, outputLimit - Buffer.byteLength(current));
      const addition = chunk.toString("utf8", 0, room);
      if (target === "stdout") stdout += addition;
      else stderr += addition;
      if (Buffer.byteLength(chunk) > room) truncated = true;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      const result = { exitCode: code, signal: exitSignal, stdout, stderr, truncated };
      if (code === 0) resolve(result);
      else {
        const error = new Error(`Check failed with exit code ${code}: ${executable}`);
        error.result = result;
        reject(error);
      }
    });
  });
}
