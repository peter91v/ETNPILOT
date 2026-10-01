import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Reading a line-per-record file without holding the file. A receipt grows with
// every tool call, and one whose outputs are large passes any limit placed on the
// whole file; the limit that makes sense is on one line.

const CHUNK = 64 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

async function openRegular(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const details = await handle.stat();
  if (!details.isFile()) {
    await handle.close();
    throw new Error("Not a regular file.");
  }
  return { handle, size: details.size };
}

// Yields each line (without its newline) as a string. An empty line in the middle
// is yielded as ""; the empty piece after a final newline is not a line.
export async function* readLines(path, { maxLineBytes = MAX_LINE_BYTES, signal } = {}) {
  const { handle, size } = await openRegular(path);
  try {
    const buffer = Buffer.alloc(CHUNK);
    let position = 0;
    let pending = [];
    let pendingBytes = 0;
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        pending.push(Buffer.from(buffer.subarray(start, index)));
        pendingBytes += index - start;
        if (pendingBytes > maxLineBytes) throw tooLong(maxLineBytes);
        yield Buffer.concat(pending, pendingBytes).toString("utf8");
        pending = [];
        pendingBytes = 0;
        start = index + 1;
      }
      if (start < bytesRead) {
        pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        pendingBytes += bytesRead - start;
        if (pendingBytes > maxLineBytes) throw tooLong(maxLineBytes);
      }
    }
    // A last line with no newline after it was cut off mid-write or is complete;
    // either way it is the file's last line.
    if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

// The last non-empty line, read from the end: the cost does not grow with the file.
export async function readLastLine(path, { maxLineBytes = MAX_LINE_BYTES } = {}) {
  const { handle, size } = await openRegular(path);
  try {
    let end = size;
    let collected = Buffer.alloc(0);
    while (end > 0) {
      const length = Math.min(CHUNK, end);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, end - length);
      end -= length;
      collected = Buffer.concat([chunk, collected]);
      const trimmed = collected.toString("utf8").replace(/\s+$/, "");
      const at = trimmed.lastIndexOf("\n");
      if (at !== -1) return trimmed.slice(at + 1);
      if (collected.length > maxLineBytes) throw tooLong(maxLineBytes);
    }
    const text = collected.toString("utf8").replace(/\s+$/, "");
    return text === "" ? undefined : text;
  } finally {
    await handle.close();
  }
}

function tooLong(limit) {
  return Object.assign(new Error(`A line is longer than ${limit} bytes.`), { code: "line_too_long" });
}
