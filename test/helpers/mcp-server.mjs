// A minimal MCP server over stdio, for testing the client against something
// that speaks the protocol rather than against a mock of it.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        {
          name: "shout",
          description: "Returns the text in capitals.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        {
          name: "explode",
          description: "Always reports an error.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.name === "explode") {
      reply(message.id, { isError: true, content: [{ type: "text", text: "it went wrong" }] });
      return;
    }
    reply(message.id, { content: [{ type: "text", text: String(message.params.arguments.text).toUpperCase() }] });
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
}
