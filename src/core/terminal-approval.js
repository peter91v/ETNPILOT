import { createInterface } from "node:readline/promises";
import { sanitizeForDisplay } from "./text-safety.js";

export function createTerminalApprovalHandler({ input = process.stdin, output = process.stdout } = {}) {
  let pending = Promise.resolve();
  return (request, context) => {
    const operation = pending.then(() => askForApproval(request, context, { input, output }));
    pending = operation.catch(() => {});
    return operation;
  };
}

async function askForApproval(request, context, { input, output }) {
  if (!input.isTTY || !output.isTTY) {
    return { kind: "reject", reason: "Interactive approval is unavailable." };
  }
  const details = describeRequest(request);
  const readline = createInterface({ input, output });
  try {
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
function describeRequest(request) {
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
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function display(value) {
  const { text, truncated } = sanitizeForDisplay(value ?? "", { maxLength: 8192 });
  return truncated ? `${text} […truncated, inspect with 'etnpilot approval show']` : text;
}
