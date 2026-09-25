import { spawn } from "node:child_process";

// A Model Context Protocol client, so a project can give its agents tools this
// project did not write.
//
// It existed for exactly one provider and exactly one server: the Copilot
// adapter was handed a hardcoded codegraph descriptor, and 'anthropic' and
// 'openai' had no MCP at all. But MCP is an open protocol and a client for it
// is a property of the harness, not of a provider — which is also the only way
// its tools can go through the same approval path as everything else.
//
// Deliberately small: stdio transport, newline-delimited JSON-RPC, the three
// calls that matter. No resources, no prompts, no sampling — a server that
// wants to ask the model something of its own is a different conversation, and
// one this project would have to decide about rather than inherit.

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

export function createMcpClient({
  name,
  command,
  args = [],
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  if (!name) throw new TypeError("An MCP server needs a name.");
  if (!command) throw new TypeError(`MCP server '${name}' needs a command.`);

  let child;
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const pending = new Map();

  const settleAll = (error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  const start = () => {
    child = spawnImpl(command, args, {
      cwd,
      // Never the caller's whole environment: a server this project did not
      // write should not inherit its secrets by default.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) deliver(line);
        newline = buffer.indexOf("\n");
      }
    });
    // A server's own logging goes to stderr by convention; it is not an error
    // and it is not ours to print.
    child.stderr.resume();
    child.once("error", (error) => {
      closed = true;
      settleAll(new Error(`MCP server '${name}' could not start: ${error.message}`));
    });
    child.once("exit", (code) => {
      closed = true;
      settleAll(new Error(`MCP server '${name}' exited (${code ?? "signal"}) while a call was outstanding.`));
    });
  };

  const deliver = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A server that writes something else on stdout is broken, but one bad
      // line is not a reason to abandon the ones that follow.
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(`MCP server '${name}': ${message.error.message ?? "call failed"}`));
      return;
    }
    entry.resolve(message.result);
  };

  const send = (method, params) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error(`MCP server '${name}' is not running.`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP server '${name}' did not answer '${method}' within ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const notify = (method, params) => {
    if (closed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  return {
    name,
    async initialize() {
      start();
      const result = await send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: "etnpilot", version: "0.1.0" },
      });
      notify("notifications/initialized", {});
      return result;
    },
    async listTools() {
      const result = await send("tools/list", {});
      return (result?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
      }));
    },
    async callTool(tool, args) {
      const result = await send("tools/call", { name: tool, arguments: args ?? {} });
      // The protocol's own failure shape: the call succeeded, the tool did not.
      if (result?.isError) {
        return { ok: false, error: textOf(result.content) || `MCP tool '${tool}' reported an error.` };
      }
      return { ok: true, content: textOf(result?.content), ...(result?.structuredContent ? { structured: result.structuredContent } : {}) };
    },
    close() {
      if (closed || !child) return;
      closed = true;
      settleAll(new Error(`MCP server '${name}' was closed.`));
      child.stdin.end();
      child.kill();
    },
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
            const decision = await context.approve({
              kind: "mcp",
              toolName: `${name}.${tool.name}`,
              toolArguments: args,
            });
            if (decision.kind !== "approve-once") {
              return { ok: false, error: decision.reason ?? "Refused." };
            }
            return client.callTool(tool.name, args);
          },
        });
      }
      clients.push(client);
    } catch (error) {
      // A server that will not start is not a reason to lose the run: the
      // tools it would have offered are absent, and the receipt says so.
      client.close();
      onError?.({ server: name, error: error.message });
    }
  }
  return { tools, close: () => clients.forEach((client) => client.close()) };
}
