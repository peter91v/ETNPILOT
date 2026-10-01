import { createHash } from "node:crypto";

export function providerToolName(name) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `mcp_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 42)}_${digest}`;
}

export function providerToolNames(definitions = []) {
  const names = new Map();
  for (const definition of definitions) {
    const wire = providerToolName(definition.name);
    if (names.has(wire)) throw new Error(`Duplicate provider tool name '${wire}'.`);
    names.set(wire, definition.name);
  }
  return { definitions: definitions.map((tool) => ({ ...tool, name: providerToolName(tool.name) })), internal: (wire) => names.get(wire) ?? wire };
}
