import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import YAML from "yaml";

// What 'etnpilot init' brings along from a project that already works with
// another coding agent: its instructions, its agents and its skills. Nothing
// here runs the content, and nothing is overwritten — a file that is already
// in '.etnpilot' stays as it is. Everything that arrives is unreviewed until
// someone looks at it and runs 'etnpilot content lock', which is the point of
// that lock.

const SKIP_DIRECTORIES = new Set([".git", ".etnpilot", "node_modules", "dist", "build", "vendor", ".venv", "venv", "target", ".next", "coverage"]);
const MAX_DEPTH = 4;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 200;

// Instruction files by the tool that reads them. The same text is often in
// two of them (AGENTS.md next to a CLAUDE.md that points at it); identical
// content is imported once.
const INSTRUCTION_FILES = Object.freeze({
  "CLAUDE.md": "claude",
  "CLAUDE.local.md": null, // personal by design; never copied into a shared project
  "AGENTS.md": "agents",
  "GEMINI.md": "gemini",
});
const FIXED_INSTRUCTIONS = Object.freeze([
  [".claude/CLAUDE.md", "claude"],
  [".github/copilot-instructions.md", "copilot"],
  [".cursorrules", "cursor"],
]);

const AGENT_DIRECTORIES = Object.freeze([
  [".claude/agents", "claude"],
  [".opencode/agent", "opencode"],
  [".opencode/agents", "opencode"],
  [".github/agents", "copilot"],
]);
const SKILL_DIRECTORIES = Object.freeze([
  ".claude/skills",
  ".agents/skills",
  ".opencode/skill",
  ".opencode/skills",
]);

// The other tools' names for what ETNPilot calls a tool. Anything not listed
// (an MCP server, a notebook editor, a web search) is reported, not guessed.
const TOOL_NAMES = Object.freeze({
  read: "read_file",
  glob: "list_files",
  ls: "list_files",
  list: "list_files",
  grep: "search_files",
  search: "search_files",
  write: "write_file",
  edit: "edit_file",
  multiedit: "edit_file",
  patch: "edit_file",
  bash: "run_command",
  shell: "run_command",
  execute: "run_command",
  webfetch: "fetch_url",
  fetch: "fetch_url",
  task: "spawn_subagent",
  agent: "spawn_subagent",
  askuserquestion: "ask_human",
  skill: "load_skill",
});
const EVERY_TOOL = Object.freeze(["read_file", "list_files", "search_files", "write_file", "edit_file", "run_command", "fetch_url"]);

// With 'dryRun' nothing is written: the report says what would be imported, so a
// surface can show it before anyone has chosen to create the project.
export async function importExistingProject(root, { configDir = join(root, ".etnpilot"), dryRun = false } = {}) {
  const report = { instructions: [], agents: [], skills: [], skipped: [], notes: [], dryRun };
  const seen = new Set();
  dry = dryRun;
  try {
    await importInstructions(root, configDir, report, seen);
    const agentNames = new Set();
    await importAgents(root, configDir, report, agentNames);
    await importSkills(root, configDir, report);
    await noteWhatIsLeft(root, report);
  } finally {
    dry = false;
  }
  return report;
}

export function summarizeImport(report) {
  const lines = [];
  const count = (list, word) => `${list.length} ${word}${list.length === 1 ? "" : "s"}`;
  if (report.instructions.length + report.agents.length + report.skills.length > 0) {
    lines.push(`${report.dryRun ? "Found" : "Imported"} ${count(report.instructions, "instruction file")}, ${count(report.agents, "agent")} and ${count(report.skills, "skill")} ${report.dryRun ? "that can be brought along" : "from this project"}:`);
    for (const entry of [...report.instructions, ...report.agents, ...report.skills]) lines.push(`  ${entry.from}  ->  ${entry.to}`);
  }
  for (const entry of report.skipped) lines.push(`  not imported: ${entry.from} — ${entry.reason}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines;
}

// ---------------------------------------------------------------- instructions

async function importInstructions(root, configDir, report, seen) {
  const found = [];
  for (const [path, tool] of FIXED_INSTRUCTIONS) found.push({ path, tool, scope: "" });
  const order = Object.keys(INSTRUCTION_FILES);
  const walked = (await walkForNamed(root, order)).sort((left, right) => order.indexOf(basename(left)) - order.indexOf(basename(right)) || left.localeCompare(right));
  for (const path of walked) {
    const tool = INSTRUCTION_FILES[basename(path)];
    if (tool === null) {
      report.skipped.push({ from: path, reason: "personal file, not shared with the project" });
      continue;
    }
    found.push({ path, tool, scope: dirname(path) === "." ? "" : dirname(path) });
  }
  for (const rule of await listFiles(join(root, ".cursor", "rules"), [".md", ".mdc"])) {
    found.push({ path: `.cursor/rules/${rule}`, tool: `cursor-${stem(rule)}`, scope: "", rule: true });
  }
  for (const entry of found) {
    const text = await readText(join(root, entry.path), report, entry.path);
    if (text === undefined || text.trim() === "") continue;
    let body = text;
    let origin = "";
    if (entry.rule) {
      const { data, body: rest } = splitFrontmatter(text);
      body = rest;
      const globs = [data?.globs].flat().filter(Boolean).join(", ");
      origin = [data?.description, globs ? `applied to ${globs} in the source` : ""].filter(Boolean).join("; ");
    }
    const digest = createHash("sha256").update(body.trim()).digest("hex");
    if (seen.has(digest)) {
      report.skipped.push({ from: entry.path, reason: "same text as a file already imported" });
      continue;
    }
    seen.add(digest);
    const target = join(configDir, "instructions", entry.scope, `imported-${entry.tool}.md`);
    const header = `<!-- Imported from ${entry.path} by 'etnpilot init'${origin ? ` (${origin})` : ""}. Review it, then run 'etnpilot content lock'. -->\n\n`;
    if (!(await writeNew(target, header + body.trim() + "\n"))) {
      report.skipped.push({ from: entry.path, reason: `${relative(root, target)} already exists` });
      continue;
    }
    report.instructions.push({ from: entry.path, to: relative(root, target) });
    if (/^@\S+/m.test(body)) report.notes.push(`${entry.path} contains '@file' imports; they were copied as text and are not followed.`);
  }
}

// ---------------------------------------------------------------------- agents

async function importAgents(root, configDir, report, names) {
  for (const [directory, tool] of AGENT_DIRECTORIES) {
    for (const file of await listFiles(join(root, directory), [".md"])) {
      const path = `${directory}/${file}`;
      const text = await readText(join(root, path), report, path);
      if (text === undefined) continue;
      const { data, body } = splitFrontmatter(text);
      const name = slug(data?.name ?? file.replace(/(\.agent)?\.md$/, ""));
      if (!name || body.trim() === "") {
        report.skipped.push({ from: path, reason: "no usable name or prompt" });
        continue;
      }
      if (names.has(name)) {
        report.skipped.push({ from: path, reason: `an agent called '${name}' was already imported` });
        continue;
      }
      const manifestPath = join(configDir, "agents", `${name}.yaml`);
      const promptPath = join(configDir, "prompts", `${name}.md`);
      if (await exists(manifestPath) || await exists(promptPath)) {
        report.skipped.push({ from: path, reason: `.etnpilot/agents/${name}.yaml already exists` });
        continue;
      }
      names.add(name);
      const mapped = mapTools(data?.tools ?? data?.allowedTools, report, path);
      const skills = [data?.skills].flat().filter((skill) => typeof skill === "string").map(slug).filter(Boolean);
      const lines = [
        `# Imported from ${path} by 'etnpilot init' (${tool}). Review it, then run 'etnpilot content lock'.`,
        ...(data?.description ? [`# Description in the source: ${String(data.description).split("\n")[0]}`] : []),
        ...(data?.model ? [`# Model in the source: ${data.model}. Not copied: model names differ between providers. Set 'model' or 'provider' here if you want one.`] : []),
        YAML.stringify({ name, promptRef: name, skills, requires: ["chat"], subagents: [] }).trimEnd(),
        ...(mapped.tools === undefined
          ? ["# The source did not restrict this agent's tools, so neither does this file. Name them with 'tools: [...]' to make it read-only, for example."]
          : [YAML.stringify({ tools: mapped.tools }, { flowCollectionPadding: false }).trimEnd()]),
      ];
      await writeNew(promptPath, body.trim() + "\n");
      await writeNew(manifestPath, lines.join("\n") + "\n");
      report.agents.push({ from: path, to: `.etnpilot/agents/${name}.yaml` });
    }
  }
}

function mapTools(value, report, path) {
  if (value === undefined || value === null) return { tools: undefined };
  let allowed;
  let denied = [];
  if (typeof value === "string") allowed = value.split(",").map((item) => item.trim()).filter(Boolean);
  else if (Array.isArray(value)) allowed = value.map(String);
  else if (typeof value === "object") {
    allowed = Object.entries(value).filter(([, on]) => on === true).map(([key]) => key);
    denied = Object.entries(value).filter(([, on]) => on === false).map(([key]) => key);
  } else return { tools: undefined };
  const tools = new Set();
  const unmapped = [];
  if (allowed.length === 0 && denied.length > 0) for (const tool of EVERY_TOOL) tools.add(tool);
  for (const entry of allowed) {
    const mapped = TOOL_NAMES[entry.toLowerCase().replace(/\(.*$/, "").trim()];
    if (mapped) tools.add(mapped);
    else unmapped.push(entry);
  }
  for (const entry of denied) {
    const mapped = TOOL_NAMES[entry.toLowerCase()];
    if (mapped) tools.delete(mapped);
  }
  if (unmapped.length > 0) report.notes.push(`${path}: tools with no ETNPilot counterpart were left out (${unmapped.join(", ")}).`);
  return { tools: [...tools] };
}

// ---------------------------------------------------------------------- skills

async function importSkills(root, configDir, report) {
  for (const directory of SKILL_DIRECTORIES) {
    const base = join(root, directory);
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const name = slug(entry.name);
      const source = join(base, entry.name);
      if (!name || !(await exists(join(source, "SKILL.md")))) {
        report.skipped.push({ from: `${directory}/${entry.name}`, reason: "no SKILL.md" });
        continue;
      }
      const target = join(configDir, "skills", name);
      if (await exists(target)) {
        report.skipped.push({ from: `${directory}/${entry.name}`, reason: `.etnpilot/skills/${name} already exists` });
        continue;
      }
      const copied = await copyTree(source, target, report, `${directory}/${entry.name}`, dry);
      if (copied === 0) continue;
      report.skills.push({ from: `${directory}/${entry.name}`, to: `.etnpilot/skills/${name}` });
    }
  }
}

async function copyTree(source, target, report, label, dryRun = false) {
  let copied = 0;
  async function visit(from, to, depth) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        report.notes.push(`${label}: symbolic link '${entry.name}' was not followed.`);
        continue;
      }
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await visit(sourcePath, targetPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || copied >= MAX_SKILL_FILES) continue;
      const details = await lstat(sourcePath);
      if (details.size > MAX_FILE_BYTES) {
        report.notes.push(`${label}: '${entry.name}' is over 1 MiB and was not copied.`);
        continue;
      }
      if (!dryRun) {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, await readFile(sourcePath), { flag: "wx" });
      }
      copied += 1;
    }
  }
  await visit(source, target, 0);
  return copied;
}

// -------------------------------------------------------------- what stays behind

async function noteWhatIsLeft(root, report) {
  if (await exists(join(root, ".claude", "commands"))) {
    report.notes.push("`.claude/commands` (slash commands) have no counterpart: a run is not interactive.");
  }
  for (const settings of [".claude/settings.json", ".mcp.json", "opencode.json", ".cursor/mcp.json"]) {
    if (await exists(join(root, settings))) {
      report.notes.push(`${settings} (hooks, MCP servers, permissions) was not read: those are locked settings in ETNPilot and are set deliberately in .etnpilot/etnpilot.yaml.`);
    }
  }
}

// --------------------------------------------------------------------- helpers

export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: undefined, body: text };
  try {
    const data = YAML.parse(match[1]);
    return { data: data && typeof data === "object" && !Array.isArray(data) ? data : undefined, body: match[2] };
  } catch {
    return { data: undefined, body: text };
  }
}

function slug(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function stem(file) {
  return slug(basename(file, extname(file)));
}

async function walkForNamed(root, names, directory = root, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
      await walkForNamed(root, names, join(directory, entry.name), depth + 1, found);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && names.includes(entry.name)) {
      found.push(relative(root, join(directory, entry.name)));
    }
  }
  return found.sort();
}

async function listFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && extensions.includes(extname(entry.name))).map((entry) => entry.name).sort();
}

async function readText(path, report, label) {
  const details = await lstat(path).catch(() => undefined);
  if (!details) return undefined;
  if (details.size > MAX_TEXT_BYTES && !details.isSymbolicLink()) {
    report.skipped.push({ from: label, reason: `over ${MAX_TEXT_BYTES / 1024} KiB` });
    return undefined;
  }
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  if (text.length > MAX_TEXT_BYTES) {
    report.skipped.push({ from: label, reason: `over ${MAX_TEXT_BYTES / 1024} KiB` });
    return undefined;
  }
  return text;
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => undefined));
}

let dry = false;

async function writeNew(path, content) {
  if (dry) return !(await exists(path));
  await mkdir(dirname(path), { recursive: true });
  return writeFile(path, content, { encoding: "utf8", flag: "wx" }).then(() => true, (error) => {
    if (error.code === "EEXIST") return false;
    throw error;
  });
}
