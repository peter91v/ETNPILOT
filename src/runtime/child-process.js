import { spawn } from "node:child_process";
import { utf8Prefix } from "./bounded-io.js";

export const processGroupOptions = () => ({ detached: process.platform !== "win32" });

export function signalTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  child.kill(signal);
}

export async function stopChild(child, { graceMs = 250 } = {}) {
  if (!child?.pid) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  signalTree(child);
  let timer;
  try {
    await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
    // The leader can exit while its descendants still own the group's pipes.
    signalTree(child, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await closed;
  } finally { clearTimeout(timer); }
}

export async function runChild(command, { cwd, env, signal, input, timeoutMs = 120_000, outputLimit = 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const child = spawn(command[0], command.slice(1), { cwd, env, shell: false, ...processGroupOptions(), stdio: ["pipe", "pipe", "pipe"] });
  const chunks = { stdout: [], stderr: [] };
  let size = 0;
  let truncated = false;
  let timedOut = false;
  let timer;
  const abort = () => signalTree(child, "SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  try {
    const result = await new Promise((resolve, reject) => {
      for (const target of ["stdout", "stderr"]) child[target].on("data", (chunk) => {
        const room = Math.max(0, outputLimit - size);
        chunks[target].push(chunk.subarray(0, room));
        size += Math.min(chunk.length, room);
        if (chunk.length > room) { truncated = true; signalTree(child, "SIGKILL"); }
      });
      timer = setTimeout(() => { timedOut = true; signalTree(child, "SIGKILL"); }, timeoutMs);
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal, timedOut, truncated }));
    });
    signal?.throwIfAborted();
    return { ...result, stdout: utf8Prefix(Buffer.concat(chunks.stdout)), stderr: utf8Prefix(Buffer.concat(chunks.stderr)) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    signalTree(child, "SIGKILL");
    const nameIndex = command.indexOf("--name");
    const name = command[nameIndex + 1];
    if (["docker", "podman"].includes(command[0]) && command[1] === "run" && nameIndex > 1
      && /^etnpilot-command-[a-f0-9-]{36}$/.test(name) && command.includes(`etnpilot.command=${name}`)) {
      const cleanup = await runChild([command[0], "rm", "--force", name], { env, timeoutMs: 5000, outputLimit: 16 * 1024 }).catch((error) => ({ exitCode: -1, stderr: error.message }));
      if (cleanup.exitCode !== 0 && !/no such container|does not exist/i.test(cleanup.stderr)) throw new Error(`Sandbox container cleanup failed: ${cleanup.stderr}`);
    }
  }
}
