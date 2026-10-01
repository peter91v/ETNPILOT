// @ts-check
import { parentPort, workerData } from "node:worker_threads";

try {
  const { files, pattern, literal, ignoreCase, limit } = workerData;
  const matcher = literal ? undefined : new RegExp(pattern, ignoreCase ? "i" : "");
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const matches = [];
  let truncated = false;
  outer: for (const file of files) {
    for (const [index, line] of file.content.split("\n").entries()) {
      if (matches.length >= limit) { truncated = true; break outer; }
      const found = literal ? (ignoreCase ? line.toLowerCase() : line).includes(needle) : /** @type {RegExp} */ (matcher).test(line);
      if (found) matches.push({ path: file.path, line: index + 1, text: line.length > 200 ? `${line.slice(0, 200)}…` : line });
    }
  }
  parentPort?.postMessage({ ok: true, matches, files: files.length, truncated });
} catch (error) { parentPort?.postMessage({ ok: false, error: `'pattern' is not a valid regular expression: ${error.message}` }); }
