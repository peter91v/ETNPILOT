// @ts-check
import { Worker } from "node:worker_threads";

export async function searchLines(data, { signal, timeoutMs = 1000 } = /** @type {any} */ ({})) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./search-worker.js", import.meta.url), {
    workerData: data, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
  });
  let timer;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve({ ok: false, error: `Search exceeded its ${timeoutMs}ms limit.` }), timeoutMs);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`Search worker exited (${code}).`)); });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
