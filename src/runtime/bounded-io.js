import { constants } from "node:fs";
import { open } from "node:fs/promises";

export function utf8Prefix(bytes, limit = bytes.length) {
  const prefix = Buffer.from(bytes).subarray(0, limit);
  return new TextDecoder("utf-8", { fatal: false }).decode(prefix, { stream: true });
}

export async function readHandle(handle, maxBytes, { signal, truncate = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Read byte limit must be a positive integer.");
  const details = await handle.stat();
  if (!details.isFile()) throw new Error("Not a regular file.");
  if (!truncate && details.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);
  const chunks = [];
  let position = 0;
  while (position <= maxBytes) {
    signal?.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) return Buffer.concat(chunks, position);
    position += bytesRead;
    if (position > maxBytes && truncate) return Buffer.concat([...chunks, chunk.subarray(0, bytesRead)], position).subarray(0, maxBytes);
    if (position > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);
}

export async function readRegularFile(path, maxBytes, options = {}) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { return await readHandle(handle, maxBytes, options); }
  finally { await handle.close(); }
}

// Read at most limit bytes, and cancel the source even when the body is endless.
export async function readResponseBytes(response, limit, { signal, truncate = false } = {}) {
  if (!response.body?.getReader) throw new Error("Response has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return { bytes: Buffer.concat(chunks, total), truncated: false };
      const chunk = Buffer.from(value);
      const room = limit - total;
      if (chunk.length > room) {
        if (!truncate) throw new Error(`Response exceeds the ${limit}-byte limit.`);
        chunks.push(chunk.subarray(0, room));
        return { bytes: Buffer.concat(chunks, limit), truncated: true };
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function cancelBody(response) {
  await response?.body?.cancel?.().catch(() => {});
}
