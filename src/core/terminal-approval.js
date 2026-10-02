// @ts-check
import { createInterface } from "node:readline/promises";
import { sanitizeForDisplay } from "./text-safety.js";

export function createTerminalApprovalHandler({ input = process.stdin, output = process.stdout } = /** @type {any} */ ({})) {
  let pending = Promise.resolve();
  return (request, context) => {
    const operation = pending.then(() => askForApproval(request, context, { input, output }));
    pending = operation.then(() => {}, () => {});
    return operation;
  };
}

async function askForApproval(request, context, { input, output }) {
  if (!input.isTTY || !output.isTTY) {
    return { kind: "reject", reason: "Interactive approval is unavailable." };
  }
  const readline = createInterface({ input, output });
  try {
    // A question is answered, not approved: the text typed is the answer, and
    // an empty line leaves it unanswered.
    if (request.kind === "question") {
      const position = request.toolArguments?.number ? ` (${request.toolArguments.number} of ${request.toolArguments.of})` : "";
      const options = Array.isArray(request.toolArguments?.options) ? `\nOptions: ${request.toolArguments.options.map(display).join(" | ")}` : "";
      const answer = await readline.question(`\nETNPilot asks${position}: ${display(request.fullCommandText)}${options}\nYour answer (empty to leave it open): `);
      return answer.trim() === ""
        ? { kind: "reject", reason: "Not answered." }
        : { kind: "approve-once", answer: answer.trim() };
    }
    const details = describeRequest(request);
    const answer = await readline.question(
      `\nETNPilot approval required\nAgent: ${display(context.agent)}\nOperation: ${display(request.kind ?? "unknown")}${details}\nApprove once? [y/N] `,
    );
    return /^(y|yes|j|ja)$/i.test(answer.trim())
      ? { kind: "approve-once" }
      : { kind: "reject", reason: "Rejected by the user." };
  } finally {
    readline.close();
  }
}

// Every field below is agent-controlled text rendered into a terminal, so it
// is escaped rather than printed raw, and shown in full rather than summarized.
export function describeRequest(request) {
  const lines = [];
  if (request.fullCommandText) lines.push(`Command: ${display(request.fullCommandText)}`);
  if (request.fileName) lines.push(`File: ${display(request.fileName)}`);
  if (request.toolName) lines.push(`Tool: ${display(request.toolName)}`);
  if (request.url) lines.push(`URL: ${display(request.url)}`);
  if (request.toolArguments !== undefined) {
    lines.push(`Arguments: ${display(
      typeof request.toolArguments === "string" ? request.toolArguments : JSON.stringify(request.toolArguments),
    )}`);
  }
  // Last, and whole: it is the thing being decided, and it is the only field
  // that runs to several lines.
  if (request.diff) lines.push(`Changes:\n${display(request.diff, { allowNewlines: true })}`);
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

export function display(value, { allowNewlines = false } = /** @type {any} */ ({})) {
  // A diff is lines; escaping its newlines turns it into one unreadable row.
  // Every other control character is still escaped.
  const { text, truncated } = sanitizeForDisplay(value ?? "", { maxLength: 8192, allowNewlines });
  return truncated ? `${text} […truncated, inspect with 'etnpilot approval show']` : text;
}
