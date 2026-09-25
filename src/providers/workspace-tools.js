import { spawn } from "node:child_process";
import { tail } from "../checks/runner.js";
import { unifiedDiff } from "./text-diff.js";
import { readdir, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxOutputBytes: 64 * 1024,
  maxEntries: 500,
  shellTimeoutMs: 120_000,
});

// The tools a chat provider may call. Each one is mediated: the workspace
// boundary is enforced here, and every effect goes through the approval path
// before it happens, exactly like the Copilot adapter's permission requests.
export const WORKSPACE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace root." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description: "List entries of a workspace directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace root." } },
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file in the workspace. Requires human approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Complete new file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact piece of text in a workspace file, leaving everything else byte for byte."
      + " Prefer this over write_file for changing an existing file. 'old_string' must appear"
      + " exactly once unless replace_all is true. Requires human approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        old_string: { type: "string", description: "The exact text to replace, including indentation." },
        new_string: { type: "string", description: "The text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a command in the workspace without a shell. Provide argv as an array, for example"
      + " [\"npm\", \"test\"]. Shell syntax such as pipes or redirection is not interpreted."
      + " Requires human approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
]);

export function createWorkspaceTools({ workingDirectory, limits = {}, signal, sandbox } = {}) {
  if (!workingDirectory) throw new TypeError("Workspace tools require a workingDirectory.");
  const root = resolve(workingDirectory);
  const bounds = { ...DEFAULT_LIMITS, ...limits };

  return {
    definitions: WORKSPACE_TOOL_DEFINITIONS,
    async invoke(name, rawArguments, context) {
      const parsed = parseArguments(rawArguments);
      // Arguments that could not be read used to become an empty object, so
      // the model was told 'content must be a string' when the real answer
      // was that its JSON did not parse.
      if (parsed.ok === false) return parsed;
      const args = parsed.value;
      switch (name) {
        case "read_file": return readWorkspaceFile(root, bounds, args, context);
        case "list_files": return listWorkspaceFiles(root, bounds, args, context);
        case "write_file": return writeWorkspaceFile(root, bounds, args, context);
        case "edit_file": return editWorkspaceFile(root, bounds, args, context);
        case "run_command": return runWorkspaceCommand(root, bounds, args, context, signal, sandbox);
        default: return { ok: false, error: `Unknown tool '${name}'.` };
      }
    },
  };
}

async function readWorkspaceFile(root, bounds, args, context) {
  const path = containedPath(root, args.path);
  if (!path.ok) return path;
  const decision = await context.approve({ kind: "read", fileName: path.relative, toolName: "read_file" });
  if (decision.kind !== "approve-once") return denied(decision);
  try {
    const details = await stat(path.absolute);
    if (!details.isFile()) return { ok: false, error: "Not a regular file." };
    if (details.size > bounds.maxFileBytes) {
      return { ok: false, error: `File exceeds the ${bounds.maxFileBytes}-byte read limit.` };
    }
    return { ok: true, path: path.relative, content: await readFile(path.absolute, "utf8") };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function listWorkspaceFiles(root, bounds, args, context) {
  // The schema marks 'path' optional, so a missing one — and an empty string,
  // which is how a model writes 'no path' — is the workspace root. Refusing
  // it contradicted this tool's own description.
  const requested = typeof args.path === "string" ? args.path.trim() : args.path;
  const path = containedPath(root, requested === undefined || requested === "" ? "." : requested);
  if (!path.ok) return path;
  const decision = await context.approve({ kind: "read", fileName: path.relative, toolName: "list_files" });
  if (decision.kind !== "approve-once") return denied(decision);
  try {
    const entries = await readdir(path.absolute, { withFileTypes: true });
    return {
      ok: true,
      path: path.relative,
      truncated: entries.length > bounds.maxEntries,
      entries: entries.slice(0, bounds.maxEntries).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function writeWorkspaceFile(root, bounds, args, context) {
  const path = containedPath(root, args.path);
  if (!path.ok) return path;
  if (typeof args.content !== "string") return { ok: false, error: "'content' must be a string." };
  if (Buffer.byteLength(args.content) > bounds.maxFileBytes) {
    return { ok: false, error: `Content exceeds the ${bounds.maxFileBytes}-byte write limit.` };
  }
  // What is there now, so the person deciding sees the change rather than its
  // size. A file that does not exist yet reads as an addition.
  const before = await readFile(path.absolute, "utf8").catch(() => undefined);
  const decision = await context.approve({
    kind: "write",
    fileName: path.relative,
    toolName: "write_file",
    toolArguments: { path: path.relative, bytes: Buffer.byteLength(args.content) },
    diff: unifiedDiff(before, args.content, { path: path.relative }).text,
  });
  if (decision.kind !== "approve-once") return denied(decision);
  try {
    await mkdir(dirname(path.absolute), { recursive: true });
    await writeFile(path.absolute, args.content, "utf8");
    return { ok: true, path: path.relative, bytes: Buffer.byteLength(args.content) };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

// Replacing an exact piece of text, rather than the whole file. Rewriting 800
// lines to change one costs the output tokens twice, makes the approval
// unreadable, and is how a model quietly drops a comment it was not asked to
// touch.
async function editWorkspaceFile(root, bounds, args, context) {
  const path = containedPath(root, args.path);
  if (!path.ok) return path;
  if (typeof args.old_string !== "string" || args.old_string === "") {
    return { ok: false, error: "'old_string' must be a non-empty string." };
  }
  if (typeof args.new_string !== "string") return { ok: false, error: "'new_string' must be a string." };
  if (args.old_string === args.new_string) {
    return { ok: false, error: "'old_string' and 'new_string' are identical; nothing would change." };
  }
  const before = await readFile(path.absolute, "utf8").catch((error) => ({ error }));
  if (typeof before !== "string") {
    return { ok: false, error: describe(before.error) };
  }
  const occurrences = countOccurrences(before, args.old_string);
  if (occurrences === 0) {
    // The most common failure, and the one worth explaining: the model is
    // usually one space or one newline out.
    return {
      ok: false,
      error: `'old_string' does not appear in ${path.relative}. It must match the file exactly, including indentation.`,
    };
  }
  if (occurrences > 1 && args.replace_all !== true) {
    return {
      ok: false,
      error: `'old_string' appears ${occurrences} times in ${path.relative}.`
        + " Include enough surrounding text to make it unique, or pass replace_all.",
    };
  }
  const after = args.replace_all === true
    ? before.split(args.old_string).join(args.new_string)
    : before.replace(args.old_string, args.new_string);
  if (Buffer.byteLength(after) > bounds.maxFileBytes) {
    return { ok: false, error: `The result exceeds the ${bounds.maxFileBytes}-byte write limit.` };
  }
  const diff = unifiedDiff(before, after, { path: path.relative });
  const decision = await context.approve({
    kind: "write",
    fileName: path.relative,
    toolName: "edit_file",
    toolArguments: { path: path.relative, replacements: args.replace_all === true ? occurrences : 1 },
    diff: diff.text,
  });
  if (decision.kind !== "approve-once") return denied(decision);
  try {
    await writeFile(path.absolute, after, "utf8");
    return {
      ok: true,
      path: path.relative,
      replacements: args.replace_all === true ? occurrences : 1,
      added: diff.added,
      deleted: diff.deleted,
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function countOccurrences(haystack, needle) {
  let total = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    total += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return total;
}

async function runWorkspaceCommand(root, bounds, args, context, signal, sandbox) {
  const command = args.command;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    return { ok: false, error: "'command' must be a non-empty array of strings, for example [\"npm\",\"test\"]." };
  }
  const decision = await context.approve({
    kind: "shell",
    fullCommandText: command.join(" "),
    toolName: "run_command",
    toolArguments: command,
  });
  if (decision.kind !== "approve-once") return denied(decision);
  // The approval names the command the model asked for; the sandbox decides
  // where it actually runs.
  const executed = sandbox ? sandbox.wrap(command) : command;
  return new Promise((resolveResult) => {
    const [executable, ...rest] = executed;
    // No shell: the argv array is passed through, so quoting and metacharacters
    // are never interpreted on the agent's behalf.
    const child = spawn(executable, rest, { cwd: root, shell: false, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const collect = (chunk, target) => {
      const current = target === "out" ? stdout : stderr;
      const room = Math.max(0, bounds.maxOutputBytes - Buffer.byteLength(current));
      if (Buffer.byteLength(chunk) > room) truncated = true;
      const text = chunk.toString("utf8", 0, room);
      if (target === "out") stdout += text;
      else stderr += text;
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, bounds.shellTimeoutMs);
    child.stdout.on("data", (chunk) => collect(chunk, "out"));
    child.stderr.on("data", (chunk) => collect(chunk, "err"));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, error: describe(error) });
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      resolveResult({
        ok: code === 0,
        ...(code === 0 ? {} : { error: commandFailure(command, code, exitSignal, timedOut, bounds, stderr, stdout) }),
        exitCode: code,
        signal: exitSignal ?? undefined,
        stdout,
        stderr,
        truncated,
        ...(sandbox ? { sandbox: sandbox.describe() } : {}),
      });
    });
  });
}

// Why a command failed, in one line the receipt can carry: the exit code or
// the timeout, and what the command itself said.
function commandFailure(command, code, exitSignal, timedOut, bounds, stderr, stdout) {
  const name = command[0];
  const headline = timedOut
    ? `'${name}' was killed after the ${bounds.shellTimeoutMs}ms limit`
    : code === null
      ? `'${name}' was killed by ${exitSignal ?? "a signal"}`
      : `'${name}' exited with code ${code}`;
  const said = tail(stderr) || tail(stdout);
  return said ? `${headline}: ${said}` : `${headline}, and said nothing.`;
}

function containedPath(root, value) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "'path' must be a non-empty string." };
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const candidate = relative(root, absolute);
  if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    return { ok: false, error: "Path escapes the workspace." };
  }
  return { ok: true, absolute, relative: candidate === "" ? "." : candidate.replaceAll("\\", "/") };
}

function parseArguments(rawArguments) {
  if (rawArguments === undefined || rawArguments === null) return { ok: true, value: {} };
  if (typeof rawArguments === "object") return { ok: true, value: rawArguments };
  let parsed;
  try {
    parsed = JSON.parse(String(rawArguments));
  } catch (error) {
    return { ok: false, error: `Tool arguments are not valid JSON: ${error.message}` };
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, error: "Tool arguments must be a JSON object." };
}

function denied(decision) {
  return { ok: false, error: decision.reason ?? "The operation was not approved.", approved: false };
}

function describe(error) {
  return `${error.code ? `${error.code}: ` : ""}${error.message}`;
}
