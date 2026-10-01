import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { credentialStorePath } from "../auth/credential-store.js";

// A repository someone else wrote carries a configuration, and that
// configuration is authority: the address each provider talks to, which secrets
// are read, the commands checks run, the plugins that are loaded. Running
// ETNPilot in a fresh clone would otherwise run all of it without anyone having
// looked. So the first time a project is used on this machine (and again
// whenever that authority changes) the person is shown it and asked.
//
// What is fingerprinted is what can execute or send something and is NOT
// already covered by the content lock: etnpilot.yaml, plugin code, and any
// other file under .etnpilot/ that is not content, state or a key. Agents,
// prompts, skills, instructions and workflows have their own lock.

const COVERED_BY_THE_LOCK = new Set(["agents", "prompts", "skills", "instructions", "workflows"]);
const NOT_AUTHORITY = new Set(["state", "worktrees", "keys", "secrets", "content-lock.json", "etnpilot.local.yaml"]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1_000_000;

export class TrustError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TrustError";
    this.code = "project_not_trusted";
    this.details = details;
  }
}

export function trustFilePath(env = process.env) {
  const store = credentialStorePath(env);
  return store ? join(dirname(store), "trusted-projects.json") : undefined;
}

// A digest of everything in the project that can act, plus a list of what it is.
export async function projectAuthority(root) {
  const base = resolve(root);
  const etn = join(base, ".etnpilot");
  const files = new Map();
  const walk = async (directory, depth = 0) => {
    if (depth > 6 || files.size >= MAX_FILES) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      const name = relative(etn, path);
      const top = name.split(/[\\/]/)[0];
      if (depth === 0 && (COVERED_BY_THE_LOCK.has(entry.name) || NOT_AUTHORITY.has(entry.name))) continue;
      if (NOT_AUTHORITY.has(top) && depth > 0) continue;
      if (entry.isSymbolicLink()) { files.set(name, `link:${await readlink(path).catch(() => "?")}`); continue; }
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (entry.isFile()) files.set(name, await digestOf(path));
    }
  };
  await walk(etn);

  let config = {};
  try {
    config = YAML.parse(await readFile(join(etn, "etnpilot.yaml"), "utf8")) ?? {};
  } catch {
    // An unreadable configuration is fingerprinted as the file it is.
  }
  // Plugin code may live outside .etnpilot/.
  for (const entry of Array.isArray(config.plugins) ? config.plugins : []) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (typeof path !== "string" || path.startsWith("etnpilot/")) continue;
    const absolute = resolve(base, path);
    if (relative(etn, absolute).startsWith("..")) files.set(`plugin:${path}`, await digestOf(absolute));
  }

  const sorted = [...files].sort((a, b) => a[0].localeCompare(b[0]));
  const fingerprint = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return { fingerprint, files: sorted.map(([name]) => name), summary: summarize(config) };
}

async function digestOf(path) {
  const details = await lstat(path).catch(() => undefined);
  if (!details?.isFile() || details.size > MAX_FILE_BYTES) return details ? `unreadable:${details.size}` : "missing";
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// What a person is asked to look at: short, and the parts that matter.
export function summarize(config) {
  const lines = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const where = provider.baseUrl ? ` → ${provider.baseUrl}` : "";
    const secret = provider.apiKeySecret ? `, key from secret '${provider.apiKeySecret}'` : "";
    lines.push(`provider ${name} (${provider.type})${where}${secret}`);
  }
  if (config.git?.baseUrl) lines.push(`GitLab → ${config.git.baseUrl} (project ${config.git.project ?? "?"})`);
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    lines.push(`MCP server ${name}: ${[server.command, ...(server.args ?? [])].filter(Boolean).join(" ")}`);
  }
  for (const entry of Array.isArray(config.plugins) ? config.plugins : []) {
    lines.push(`plugin ${typeof entry === "string" ? entry : entry?.path}`);
  }
  if (config.sandbox?.enabled === true) lines.push(`commands run in a ${config.sandbox.runtime ?? "container"} sandbox`);
  else lines.push("commands run directly on this machine (sandbox is off)");
  for (const [name, value] of Object.entries(config.secrets?.values ?? {})) {
    if (value?.provider === "env") lines.push(`secret ${name} ← environment variable ${value.key}`);
  }
  return lines;
}

async function readTrusted(env) {
  const path = trustFilePath(env);
  if (!path) return { path: undefined, projects: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed.projects === "object") return { path, projects: parsed.projects };
  } catch {
    // Missing or unreadable: nothing is trusted yet.
  }
  return { path, projects: {} };
}

async function keyOf(root) {
  return realpath(resolve(root)).catch(() => resolve(root));
}

export async function trustState(root, { env = process.env } = {}) {
  const [{ projects }, authority, key] = await Promise.all([readTrusted(env), projectAuthority(root), keyOf(root)]);
  const known = projects[key];
  return {
    key,
    authority,
    trusted: known?.fingerprint === authority.fingerprint,
    changed: Boolean(known) && known.fingerprint !== authority.fingerprint,
    known: Boolean(known),
  };
}

export async function trustProject(root, { env = process.env } = {}) {
  const { path, projects } = await readTrusted(env);
  if (!path) throw new Error("No home directory to remember trust in. Set ETNPILOT_HOME to a directory.");
  const authority = await projectAuthority(root);
  const key = await keyOf(root);
  projects[key] = { fingerprint: authority.fingerprint, trustedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return { key, fingerprint: authority.fingerprint };
}

export async function revokeTrust(root, { env = process.env } = {}) {
  const { path, projects } = await readTrusted(env);
  const key = await keyOf(root);
  const had = key in projects;
  delete projects[key];
  if (had && path) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
  return had;
}

// Called before anything that acts on the project's configuration. Returns when
// the project is trusted (now or already); throws TrustError when it is not and
// nobody can be asked.
export async function requireTrust(root, {
  env = process.env,
  accept = false,
  ask,
  say = () => {},
} = {}) {
  // The test runner and an explicit variable are the two ways to skip the
  // question; a pipeline that checks out its own repository sets the variable.
  if (env.ETNPILOT_TRUST === "all") return { skipped: "ETNPILOT_TRUST" };
  if (env.NODE_TEST_CONTEXT && env.ETNPILOT_TRUST !== "enforce") return { skipped: "test" };
  const state = await trustState(root, { env });
  if (state.trusted) return { trusted: true };

  const reason = state.changed
    ? "The configuration or code that can act in this project has changed since you trusted it."
    : "This project has not been used on this machine before.";
  const shown = [
    reason,
    "What it can do when ETNPilot works in it:",
    ...state.authority.summary.map((line) => `  - ${line}`),
    `  (${state.authority.files.length} configuration/plugin file(s) under .etnpilot/ are part of this)`,
  ];
  if (accept) {
    await trustProject(root, { env });
    return { trusted: true, accepted: "flag" };
  }
  if (ask) {
    for (const line of shown) say(line);
    if (await ask("Trust this project? [y/N] ")) {
      await trustProject(root, { env });
      return { trusted: true, accepted: "asked" };
    }
  }
  throw new TrustError(
    `${shown.join("\n")}\nNot trusted, so nothing was run. Read .etnpilot/etnpilot.yaml, then 'etnpilot trust' (or pass --trust).`,
    { key: state.key },
  );
}
