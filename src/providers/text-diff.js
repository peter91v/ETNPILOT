// A unified diff, so a person can read what they are approving.
//
// Until now a write asked for a decision with a path and a byte count. That is
// not something anybody can judge: 'write 4,812 bytes to src/auth.js' is the
// same request whether the change is a comment or a back door. The review page
// says of itself that a reviewer can only approve what they can read, and for
// writes that was not true.
//
// No dependency, and bounded on purpose: the point is a person reading it, and
// nobody reads ten thousand lines. Where it has to cut, it says so, and the
// approval's fingerprint is taken over the real request, never over this.

const DEFAULT_LIMITS = Object.freeze({
  // Lines of context on each side of a change, as 'diff -U3' has always done.
  context: 3,
  // Beyond this the two sides are not compared line by line. An exact diff of
  // two four-thousand-line files is minutes of work to produce and nothing a
  // person reads, so it degrades to 'replaced wholesale' and says so.
  maxComparedLines: 2000,
  maxDiffLines: 400,
});

export function unifiedDiff(before, after, { path = "file", ...options } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (before === after) return { unchanged: true, text: "", path };

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const created = before === undefined || before === null;

  if (created) {
    const body = cut(afterLines.map((line) => `+${line}`), limits.maxDiffLines);
    return {
      created: true,
      path,
      added: afterLines.length,
      deleted: 0,
      truncated: body.truncated,
      text: [`--- /dev/null`, `+++ ${path}`, `@@ -0,0 +1,${afterLines.length} @@`, ...body.lines].join("\n"),
    };
  }

  // Both sides usually share a long head and tail; trimming them first is what
  // makes the comparison below affordable on a real source file.
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let end = 0;
  while (
    end < beforeLines.length - start
    && end < afterLines.length - start
    && beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) end += 1;

  const beforeMiddle = beforeLines.slice(start, beforeLines.length - end);
  const afterMiddle = afterLines.slice(start, afterLines.length - end);

  const tooBig = beforeMiddle.length * afterMiddle.length > limits.maxComparedLines * limits.maxComparedLines;
  const operations = tooBig
    ? [
      ...beforeMiddle.map((line) => ({ kind: "remove", text: line })),
      ...afterMiddle.map((line) => ({ kind: "add", text: line })),
    ]
    : diffLines(beforeMiddle, afterMiddle);

  const added = operations.filter((operation) => operation.kind === "add").length;
  const deleted = operations.filter((operation) => operation.kind === "remove").length;

  // Context around the change, taken from the untouched head and tail.
  const leading = beforeLines.slice(Math.max(0, start - limits.context), start);
  const trailing = beforeLines.slice(beforeLines.length - end, beforeLines.length - end + limits.context);
  const body = cut([
    ...leading.map((line) => ` ${line}`),
    ...operations.map((operation) => `${operation.kind === "add" ? "+" : operation.kind === "remove" ? "-" : " "}${operation.text}`),
    ...trailing.map((line) => ` ${line}`),
  ], limits.maxDiffLines);

  const oldStart = Math.max(1, start - leading.length + 1);
  const oldCount = leading.length + beforeMiddle.length + trailing.length;
  const newCount = leading.length + afterMiddle.length + trailing.length;
  return {
    path,
    added,
    deleted,
    // Said plainly rather than silently: the two sides were too large to line
    // up, so this reads as a wholesale replacement even where it was not.
    ...(tooBig ? { coarse: true } : {}),
    truncated: body.truncated,
    text: [
      `--- ${path}`,
      `+++ ${path}`,
      `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@`,
      ...body.lines,
    ].join("\n"),
  };
}

// Longest common subsequence over lines, which is what makes a diff read as a
// change rather than as a deletion followed by an insertion. Only ever reached
// for a region small enough that the table is affordable — the caller checks.
function diffLines(before, after) {
  const rows = before.length;
  const columns = after.length;
  const table = new Uint32Array((rows + 1) * (columns + 1));
  const at = (row, column) => row * (columns + 1) + column;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[at(row, column)] = before[row] === after[column]
        ? table[at(row + 1, column + 1)] + 1
        : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
    }
  }
  const operations = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      operations.push({ kind: "context", text: before[row] });
      row += 1;
      column += 1;
    } else if (table[at(row + 1, column)] >= table[at(row, column + 1)]) {
      operations.push({ kind: "remove", text: before[row] });
      row += 1;
    } else {
      operations.push({ kind: "add", text: after[column] });
      column += 1;
    }
  }
  while (row < rows) operations.push({ kind: "remove", text: before[row++] });
  while (column < columns) operations.push({ kind: "add", text: after[column++] });
  return operations;
}

function splitLines(value) {
  if (value === undefined || value === null) return [];
  const text = String(value);
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline ends the last line; it is not an empty line after it.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function cut(lines, limit) {
  if (lines.length <= limit) return { lines, truncated: false };
  return {
    lines: [...lines.slice(0, limit), `@@ ${lines.length - limit} more lines, not shown @@`],
    truncated: true,
  };
}
