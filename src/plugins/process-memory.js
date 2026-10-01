// @ts-check
import { readFile, readdir } from "node:fs/promises";

// procfs may expose host PIDs while Node runs in a nested PID namespace.
// Match the namespace PID and the actual host parent, never an unrelated PID.
export function createRssMeasurement(pid) {
  let hostPid;
  return async () => {
    const self = await readFile("/proc/self/status", "utf8");
    const parent = Number(/^Pid:\s+(\d+)/m.exec(self)?.[1]);
    if (!hostPid) {
      const direct = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
      if (Number(/^PPid:\s+(\d+)/m.exec(direct)?.[1]) === parent) hostPid = pid;
      else {
        for (const candidate of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).slice(0, 8192)) {
          const status = await readFile(`/proc/${candidate}/status`, "utf8").catch(() => "");
          const namespace = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
          if (namespace?.at(-1) === pid && Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) === parent) { hostPid = Number(candidate); break; }
        }
      }
    }
    if (!hostPid) throw new Error("Worker RSS cannot be measured in this PID namespace.");
    const status = await readFile(`/proc/${hostPid}/status`, "utf8");
    if (Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) !== parent) throw new Error("Worker process identity changed.");
    const rss = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
    if (!Number.isFinite(rss) || rss <= 0) throw new Error("Worker status contains no RSS measurement.");
    return rss * 1024;
  };
}
