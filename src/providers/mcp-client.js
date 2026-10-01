import { spawn } from "node:child_process";
import { processGroupOptions, stopChild } from "../runtime/child-process.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULTS = { maxMessageBytes: 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxTools: 256, maxPendingRequests: 32, shutdownTimeoutMs: 250 };

export function createMcpClient({ name, command, args = [], cwd, env, timeoutMs = 30_000, limits = {}, spawnImpl = spawn } = {}) {
  if (!name || !command) throw new TypeError("An MCP server needs a name and command.");
  const bounds = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(bounds)) if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) throw new TypeError(`Invalid MCP limit '${key}'.`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid MCP timeout.");
  let child;
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let output = 0;
  let closed = false;
  let closing;
  const pending = new Map();
  const settle = (id, error, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.cleanup();
    if (error) entry.reject(error); else entry.resolve(value);
  };
  const settleAll = (error) => { for (const id of pending.keys()) settle(id, error); };
  const close = () => {
    if (closing) return closing;
    closed = true;
    settleAll(new Error(`MCP server '${name}' was closed.`));
    child?.stdin.end();
    closing = stopChild(child, { graceMs: bounds.shutdownTimeoutMs });
    return closing;
  };
  const fatal = (reason) => { settleAll(new Error(`MCP server '${name}': ${reason}`)); void close(); };
  const deliver = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fatal("invalid JSON-RPC JSON"); return; }
    if (!message || Array.isArray(message) || typeof message !== "object" || message.jsonrpc !== "2.0") { fatal("invalid JSON-RPC envelope"); return; }
    // Unsupported server requests are refused, never executed by the host.
    if (message.method) { if (message.id !== undefined) fatal("server requests are unsupported"); return; }
    if (!Number.isSafeInteger(message.id) || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) { fatal("invalid RPC response"); return; }
    settle(message.id, message.error ? new Error(`MCP server '${name}': ${String(message.error.message ?? "call failed").slice(0, 4096)}`) : undefined, message.result);
  };
  const start = () => {
    if (child || closed) throw new Error("MCP client can only be initialized once.");
    child = spawnImpl(command, args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, ...processGroupOptions(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", (error) => fatal(error.message));
    child.stdout.on("data", (value) => {
      if (closed) return;
      const chunk = Buffer.from(value); output += chunk.length;
      if (output > bounds.maxOutputBytes) { fatal("output byte limit exceeded"); return; }
      // Split before concatenating, so several small valid frames can share a chunk.
      let offset = 0;
      while (offset < chunk.length && !closed) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (buffer.length + end - offset > bounds.maxMessageBytes) { fatal("message byte limit exceeded"); return; }
        buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
        if (newline < 0) break;
        if (buffer.length) deliver(buffer.toString("utf8"));
        buffer = Buffer.alloc(0); offset = newline + 1;
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.length; if (output > bounds.maxOutputBytes) fatal("output byte limit exceeded"); });
    child.once("error", (error) => fatal(`could not start: ${error.message}`));
    child.once("exit", (code) => fatal(`exited (${code ?? "signal"}) while a call was outstanding`));
  };
  const send = (method, params, { signal } = {}) => new Promise((resolve, reject) => {
    if (closed || !child) return reject(new Error(`MCP server '${name}' is not running.`));
    if (signal?.aborted) return reject(signal.reason);
    if (pending.size >= bounds.maxPendingRequests) { reject(new Error("MCP pending-request limit exceeded.")); return; }
    const id = nextId++;
    const wire = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    if (Buffer.byteLength(wire) > bounds.maxMessageBytes) return reject(new Error("MCP request byte limit exceeded."));
    const abort = () => { settle(id, signal.reason ?? new Error("MCP call aborted.")); void close(); };
    const timer = setTimeout(() => { settle(id, new Error(`MCP server '${name}' did not answer '${method}' within ${timeoutMs}ms.`)); void close(); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", abort) });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write(wire, (error) => { if (error) fatal(error.message); });
  });
  return {
    name,
    async initialize(options) {
      start();
      const result = await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: { name: "etnpilot", version: "0.1.0" } }, options);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      return result;
    },
    async listTools(options) {
      const result = await send("tools/list", {}, options);
      if (!Array.isArray(result?.tools) || result.tools.length > bounds.maxTools) { fatal("invalid or oversized tool list"); throw new Error("Invalid MCP tool list."); }
      const names = new Set();
      return result.tools.map((tool) => {
        if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name) || (tool.inputSchema && (typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)))) throw new Error("Invalid MCP tool definition.");
        names.add(tool.name);
        return { name: tool.name, description: String(tool.description ?? "").slice(0, 4096), parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true } };
      });
    },
    async callTool(tool, args, options) {
      const result = await send("tools/call", { name: tool, arguments: args ?? {} }, options);
      if (result?.isError) return { ok: false, error: textOf(result.content) || `MCP tool '${tool}' reported an error.` };
      return { ok: true, content: textOf(result?.content), ...(result?.structuredContent ? { structured: result.structuredContent } : {}) };
    },
    close,
  };
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// The servers a project configures, as tools the rest of the harness already
// knows how to handle: named 'server.tool' so two servers may offer the same
// name, and asked for under their own operation kind because a tool from
// somebody else's process is not a file read.
export async function connectMcpTools(servers = {}, { onError } = {}) {
  const clients = [];
  const tools = [];
  for (const [name, config] of Object.entries(servers)) {
    if (config?.enabled === false) continue;
    const client = createMcpClient({ name, ...config });
    try {
      await client.initialize();
      for (const tool of await client.listTools()) {
        const allowed = config.tools === undefined || config.tools.includes(tool.name);
        if (!allowed) continue;
        tools.push({
          definition: {
            name: `${name}.${tool.name}`,
            description: tool.description,
            parameters: tool.parameters,
          },
          async invoke(args, context) {
            // A tool the project declares read-only asks as the read it is,
            // the same way the Copilot adapter treats codegraph: otherwise a
            // read of an index would need a policy rule for 'mcp' that the
            // generated configuration deliberately does not have.
            const readOnly = config.readOnlyTools?.includes(tool.name) === true;
            const decision = await context.approve(readOnly
              ? { kind: "read", path: ".", sourceKind: "mcp", toolName: `${name}.${tool.name}`, toolArguments: args }
              : { kind: "mcp", toolName: `${name}.${tool.name}`, toolArguments: args });
            if (decision.kind !== "approve-once") {
              return { ok: false, error: decision.reason ?? "Refused." };
            }
            return client.callTool(tool.name, args, { signal: context.signal });
          },
        });
      }
      clients.push(client);
    } catch (error) {
      // A server that will not start is not a reason to lose the run: the
      // tools it would have offered are absent, and the receipt says so.
      await client.close();
      onError?.({ server: name, error: error.message });
    }
  }
  return { tools, close: () => Promise.all(clients.map((client) => client.close())) };
}
