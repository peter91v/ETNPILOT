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
  const passed = Object.keys(env ?? {}).sort();
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
    child.once("error", (error) => {
      // A command that never started reports ENOENT and nothing else; the
      // reason is the same allow-listed environment, so say so here too.
      if (error?.code === "ENOENT") {
        const failure = new Error(
          `Check could not start: ${exitCodeHint("start", executable, passed)}`,
        );
        failure.cause = error;
        failure.exitCode = 127;
        reject(failure);
        return;
      }
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      const result = { exitCode: code, signal: exitSignal, stdout, stderr, truncated };
      if (code === 0) resolve(result);
      else {
        const error = new Error(describeFailure(executable, code, result, passed));
        error.result = result;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

// What the check said is the reason it failed. Reporting the exit code alone
// leaves the output collected here and shown nowhere: the run, the receipt and
// every surface then repeat a number nobody can act on.
const OUTPUT_TAIL_LINES = 12;
const OUTPUT_TAIL_BYTES = 2000;

function describeFailure(executable, code, result, passed) {
  const headline = `Check failed with exit code ${code}: ${executable}`;
  const output = tail(result.stderr) || tail(result.stdout);
  const hint = exitCodeHint(code, executable, passed);
  return [headline, hint, output].filter(Boolean).join("\n");
}

// 126 and 127 come from the loader, not the command, so the command's own
// output is usually empty and the cause is the environment it was given.
// Checks run agent-authored code, so they inherit only allow-listed variables.
function exitCodeHint(code, executable, passed = []) {
  // What the check was actually given. Naming the allow list without saying
  // what got through leaves the next person guessing which name is missing —
  // and 'checks.envAllow' is stricter-only, so a local file can only narrow
  // it: sending someone to a change that will be refused wastes the hint.
  const envAdvice = `It inherited only these variables: ${passed.join(", ") || "none"}.`
    + " Add what it needs to 'checks.envAllow' in the committed"
    + " .etnpilot/etnpilot.yaml — that setting is stricter-only, so a local file"
    + " cannot widen it.";
  if (code === 127) return `'${executable}' was not found, so PATH may not reach it. ${envAdvice}`;
  if (code === "start") {
    // Node reports ENOENT both for a command that is not on PATH and for one
    // whose '#!' interpreter is missing, so the message must own both.
    return `'${executable}' could not be run: it was not found on PATH, or the interpreter`
      + ` on its '#!' line was not. ${envAdvice}`;
  }
  if (code === 126) {
    return `'${executable}' was found but could not be executed — a missing interpreter, a missing`
      + ` execute bit, or a variable its wrapper needs. ${envAdvice}`;
  }
  return undefined;
}

export function tail(text) {
  if (!text) return "";
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").slice(-OUTPUT_TAIL_LINES);
  const joined = lines.join("\n");
  return joined.length > OUTPUT_TAIL_BYTES ? `…${joined.slice(-OUTPUT_TAIL_BYTES)}` : joined;
}
