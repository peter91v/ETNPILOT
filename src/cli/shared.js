// @ts-check
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { createApprovalNotifier } from "../core/approval-notify.js";
import { WorkflowQueue } from "../workflow/queue.js";
import { access } from "node:fs/promises";
import { createTerminalApprovalHandler } from "../core/terminal-approval.js";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";

// Helpers the commands share.

// A list of policy rules is unreadable on one line; the point of the echo is
// to confirm what took effect, not to reprint the configuration.
export function briefValue(value) {
  if (Array.isArray(value) && value.some((entry) => entry && typeof entry === "object")) {
    return `${value.length} entries`;
  }
  const text = JSON.stringify(value);
  return text !== undefined && text.length > 120 ? `${text.slice(0, 117)}...` : String(text);
}

// Who answers a run's approval requests. The terminal asks the person who
// started the run, which needs that terminal to stay in front of them. The
// inbox lets anyone decide from anywhere — the TUI, the page, another window —
// which is also the only way to answer a run that nobody is sitting in front of.
export async function createRunApprovalHandler(root, source = "terminal") {
  if (source === "terminal") return createTerminalApprovalHandler();
  if (source !== "inbox") throw new Error(`Unknown approval source '${source}'. Use 'terminal' or 'inbox'.`);
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
  const inboxConfig = config?.approval?.inbox ?? {};
  const inbox = new ApprovalInbox(
    resolve(root, inboxConfig.database ?? ".etnpilot/state/approvals.sqlite"),
    { redact: inboxConfig.redactSecrets === true },
  );
  const handler = createInboxApprovalHandler({
    inbox,
    timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
    pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
    notifier: createApprovalNotifier(config?.approval?.notify),
    onPending: (record) => {
      console.error(`Waiting for a decision on ${record.operationKind} ${record.id} — 'etnpilot tui' or 'etnpilot approval approve'.`);
    },
  });
  return handler;
}

export async function writeOrPrint(path, document) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (!path) {
    process.stdout.write(serialized);
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, serialized, "utf8");
  console.log(`Wrote ${path}`);
}

// Opening a browser is for a person at a terminal. A pipe, a service manager,
// or CI gets the URL and nothing else, and '--open' asks for it anyway.
export function shouldOpenBrowser(values = {}, env = process.env, stdout = process.stdout) {
  if (values["no-open"]) return false;
  if (values.open) return true;
  if (typeof env.BROWSER === "string" && env.BROWSER.trim().toLowerCase() === "none") return false;
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return false;
  return stdout?.isTTY === true;
}

export function ignoreMissing(error) {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

export async function resolveReceiptPublicKeys(root, explicitPaths) {
  if (explicitPaths.length > 0) return explicitPaths.map((path) => resolve(path));
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const configured = config?.receipts?.signing?.publicKeyFile;
  if (!configured) return [];
  const path = resolve(root, configured);
  return access(path).then(() => [path], (error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

// The dates that limit when a trusted key may be relied on (see withKeyWindows).
export async function resolveKeyWindows(root) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return config?.receipts?.signing?.keyWindows;
}

export async function withWorkflowQueue(root, operation) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const database = resolve(root, config.queue?.database ?? ".etnpilot/state/workflows.sqlite");
  const queue = new WorkflowQueue(database);
  try {
    return await operation(queue);
  } finally {
    queue.close();
  }
}

export async function withApprovalInbox(root, operation) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const database = resolve(root, config.approval?.inbox?.database ?? ".etnpilot/state/approvals.sqlite");
  const inbox = new ApprovalInbox(database);
  try {
    return await operation(inbox);
  } finally {
    inbox.close();
  }
}

export function defaultWaitForShutdown() {
  return new Promise((resolveShutdown) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveShutdown(undefined);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function isBootstrapPlugin(entry) {
  return entry && typeof entry === "object" && entry.bootstrap === true;
}

