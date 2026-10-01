import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { captureProjectContent, normalizeContentProvenance, writeContentLock } from "../content/provenance.js";
import { WORKSPACE_TOOL_DEFINITIONS } from "../providers/workspace-tools.js";
import { parseWorkflowFile, renderWorkflowFile, slugName, validateWorkflowDefinition } from "../workflow/definition.js";

// What a person reviews before a run may use it, and the one act that makes
// the review count. Everything here reads the project as it is on disk now;
// nothing is cached, because the whole point is that it is what is there.

export class ContentChanged extends Error {
  constructor() {
    super("The project content changed since you opened it. Read it again before locking.");
    this.statusCode = 409;
  }
}

// Where a piece of content came from, said on its first line by whatever wrote it.
export function originOf(content) {
  const head = String(content ?? "").split("\n", 1)[0];
  if (/^(#|<!--)\s*Imported from/i.test(head)) return "imported";
  if (/^(#|<!--)\s*Forged by AgentsForge/i.test(head)) return "forged";
  if (/^(#|<!--)\s*Created in the page/i.test(head)) return "created here";
  return undefined;
}

async function readLock(root, config) {
  const settings = normalizeContentProvenance(config ?? {});
  const path = resolve(root, settings.lockFile);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return { exists: false, mode: settings.mode };
  try {
    const data = JSON.parse(text);
    return { exists: true, mode: settings.mode, entries: new Map((data.entries ?? []).map((entry) => [entry.path, entry])), digest: data.digest };
  } catch {
    return { exists: true, mode: settings.mode, entries: new Map(), broken: true };
  }
}

export async function readContentReview({ root, config }) {
  const settings = normalizeContentProvenance(config ?? {});
  const lock = await readLock(root, config);
  let snapshot;
  try {
    snapshot = await captureProjectContent(root, settings);
  } catch (error) {
    // Content that cannot be read safely (a symbolic link, a file too large)
    // is the finding, not a failure of the page.
    return { mode: settings.mode, lock: { exists: lock.exists }, items: [], removed: [], problem: error.message, canLock: false };
  }
  const items = snapshot.items.map((item) => {
    const locked = lock.entries?.get(item.path);
    return {
      type: item.type,
      name: item.name,
      path: item.path,
      bytes: item.bytes,
      digest: item.digest,
      status: !lock.exists ? "new" : !locked ? "new" : locked.digest === item.digest ? "locked" : "changed",
      ...(originOf(item.content) ? { origin: originOf(item.content) } : {}),
      summary: summarize(item),
    };
  });
  const present = new Set(items.map((item) => item.path));
  const removed = [...(lock.entries?.values() ?? [])].filter((entry) => !present.has(entry.path)).map((entry) => ({ type: entry.type, name: entry.name, path: entry.path }));
  const unreviewed = items.filter((item) => item.status !== "locked").length + removed.length;
  return {
    mode: settings.mode,
    lock: { exists: lock.exists, ...(lock.broken ? { broken: true } : {}) },
    items,
    removed,
    unreviewed,
    manifestDigest: snapshot.manifest.digest,
    canLock: unreviewed > 0 || !lock.exists,
  };
}

function summarize(item) {
  const text = String(item.content);
  if (item.type === "agent") {
    try {
      const manifest = YAML.parse(text) ?? {};
      return [manifest.description, Array.isArray(manifest.tools) ? `tools: ${manifest.tools.join(", ")}` : "all tools"].filter(Boolean).join(" · ");
    } catch { return "does not parse"; }
  }
  if (item.type === "workflow") {
    const data = parseWorkflowFile(text);
    return data?.steps ? `${data.steps.length} step${data.steps.length === 1 ? "" : "s"}: ${data.steps.map((step) => step.id).join(" → ")}` : "does not parse";
  }
  const body = text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("<!--") && !line.startsWith("#") && line !== "---" && !/^(name|description):/.test(line));
  return (body ?? "").slice(0, 120);
}

// The text of one pinned file, found by its exact path in the snapshot: this
// never opens a path the person typed.
export async function readContentFile({ root, config, path }) {
  const snapshot = await captureProjectContent(root, normalizeContentProvenance(config ?? {}));
  const item = snapshot.items.find((candidate) => candidate.path === path);
  if (!item) return undefined;
  return { type: item.type, name: item.name, path: item.path, digest: item.digest, content: item.content, ...(originOf(item.content) ? { origin: originOf(item.content) } : {}) };
}

// Locks exactly what was shown. The digest the person saw comes back with the
// request; if the content is not the same now, nothing is locked.
export async function lockReviewedContent({ root, config, manifestDigest }) {
  const review = await readContentReview({ root, config });
  if (review.problem) throw Object.assign(new Error(review.problem), { statusCode: 409 });
  if (!manifestDigest || review.manifestDigest !== manifestDigest) throw new ContentChanged();
  await writeContentLock(root, config);
  return readContentReview({ root, config });
}

// ------------------------------------------------------------------ agents in detail

export async function readAgentDetails({ root, config }) {
  const etn = join(resolve(root), ".etnpilot");
  const review = await readContentReview({ root, config }).catch(() => ({ items: [] }));
  const statusOf = new Map(review.items.map((item) => [item.path, item.status]));
  const out = [];
  for (const file of (await readdir(join(etn, "agents")).catch(() => [])).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const path = join(etn, "agents", file);
    const content = await readFile(path, "utf8").catch(() => "");
    let manifest;
    try { manifest = YAML.parse(content) ?? {}; } catch (error) { out.push({ name: file.replace(/\.ya?ml$/, ""), file, error: error.message }); continue; }
    const name = typeof manifest.name === "string" && manifest.name ? manifest.name : file.replace(/\.ya?ml$/, "");
    let prompt;
    if (manifest.promptRef) prompt = await readFile(join(etn, "prompts", `${slugName(manifest.promptRef)}.md`), "utf8").catch(() => undefined);
    else if (typeof manifest.prompt === "string") prompt = manifest.prompt;
    const provider = manifest.provider ?? (manifest.providers?.length ? undefined : config?.defaultProvider);
    out.push({
      name,
      file,
      path: `.etnpilot/agents/${file}`,
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      ...(provider ? { provider, inheritedProvider: !manifest.provider } : {}),
      ...(Array.isArray(manifest.providers) ? { providers: manifest.providers } : {}),
      ...(manifest.model ? { model: manifest.model } : {}),
      ...(manifest.effort ? { effort: manifest.effort } : {}),
      tools: Array.isArray(manifest.tools) ? manifest.tools : null,
      skills: Array.isArray(manifest.skills) ? manifest.skills : [],
      subagents: Array.isArray(manifest.subagents) ? manifest.subagents : [],
      requires: Array.isArray(manifest.requires) ? manifest.requires : [],
      promptRef: manifest.promptRef,
      promptPath: manifest.promptRef ? `.etnpilot/prompts/${slugName(manifest.promptRef)}.md` : undefined,
      prompt: prompt === undefined ? undefined : prompt.slice(0, 12_000),
      promptCut: prompt !== undefined && prompt.length > 12_000,
      lock: statusOf.get(`.etnpilot/agents/${file}`),
      ...(originOf(content) ? { origin: originOf(content) } : {}),
    });
  }
  // Who may hand work to whom, read from the other side.
  for (const agent of out) agent.usedBy = out.filter((other) => (other.subagents ?? []).includes(agent.name)).map((other) => other.name);
  return { agents: out, defaultAgent: config?.defaultAgent, providers: Object.keys(config?.providers ?? {}) };
}

// ------------------------------------------------------------------------ workflows

export async function readWorkflows({ root, config }) {
  const etn = join(resolve(root), ".etnpilot");
  const { agents } = await readAgentDetails({ root, config });
  const names = agents.filter((agent) => !agent.error).map((agent) => agent.name);
  const review = await readContentReview({ root, config }).catch(() => ({ items: [] }));
  const statusOf = new Map(review.items.map((item) => [item.path, item.status]));
  const workflows = [];
  for (const file of (await readdir(join(etn, "workflows")).catch(() => [])).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const content = await readFile(join(etn, "workflows", file), "utf8").catch(() => "");
    let data;
    try { data = parseWorkflowFile(content); } catch (error) { workflows.push({ name: file.replace(/\.ya?ml$/, ""), file, errors: [error.message], steps: [] }); continue; }
    const checked = validateWorkflowDefinition({ ...data, name: data?.name ?? file.replace(/\.ya?ml$/, "") }, { agents: names });
    workflows.push({
      name: file.replace(/\.ya?ml$/, ""),
      file,
      path: `.etnpilot/workflows/${file}`,
      description: data?.description,
      steps: Array.isArray(data?.steps) ? data.steps : [],
      errors: checked.errors,
      lock: statusOf.get(`.etnpilot/workflows/${file}`),
      ...(originOf(content) ? { origin: originOf(content) } : {}),
    });
  }
  return {
    workflows,
    // The workflow written in etnpilot.yaml, which is what a run follows when no
    // other is chosen. Shown, not edited here: it is configuration, not content.
    configured: (config?.workflow?.steps ?? []).length > 0 ? { steps: config.workflow.steps } : undefined,
    agents: names,
  };
}

export async function createWorkflow({ root, config, input }) {
  const { agents } = await readAgentDetails({ root, config });
  const checked = validateWorkflowDefinition(input, { agents: agents.filter((agent) => !agent.error).map((agent) => agent.name), maxSteps: config?.workflow?.maxSteps ?? 50 });
  if (!checked.ok) {
    throw Object.assign(new Error(checked.errors[0]), { statusCode: 400, details: { errors: checked.errors } });
  }
  const directory = join(resolve(root), ".etnpilot", "workflows");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${checked.workflow.name}.yaml`);
  const content = renderWorkflowFile(checked.workflow, { note: "Created in the page. Read it, then lock it with 'etnpilot content lock' (or in the Content view)." });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code === "EEXIST") throw Object.assign(new Error(`A workflow called '${checked.workflow.name}' already exists.`), { statusCode: 409 });
    throw error;
  });
  return { name: checked.workflow.name, path: `.etnpilot/workflows/${checked.workflow.name}.yaml`, unreviewed: true };
}

// ------------------------------------------------------------------------ agents

const EFFORTS = ["low", "medium", "high"];

// An agent made in the page. 'tools' is always written: leaving it out means
// every tool, and a form that did that by omission would hand out the most
// when someone ticked nothing.
export async function createAgent({ root, config, input }) {
  const errors = [];
  const known = WORKSPACE_TOOL_DEFINITIONS.map((definition) => definition.name);
  const name = slugName(input?.name);
  if (!name) errors.push("An agent needs a name (letters, digits, dashes).");
  const prompt = typeof input?.prompt === "string" ? input.prompt.replace(/\r\n/g, "\n").trim() : "";
  if (!prompt) errors.push("An agent needs a prompt: what it is for, and how it reports back.");
  if (prompt.length > 12_000) errors.push("The prompt is longer than 12,000 characters.");
  const asked = Array.isArray(input?.tools) ? input.tools.map(String) : [];
  const unknown = asked.filter((tool) => !known.includes(tool));
  if (unknown.length > 0) errors.push(`Unknown tools: ${unknown.join(", ")}.`);
  const etn = join(resolve(root), ".etnpilot");
  const skillNames = (await readdir(join(etn, "skills"), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const agentNames = (await readdir(join(etn, "agents")).catch(() => [])).filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, ""));
  const skills = (Array.isArray(input?.skills) ? input.skills : []).map(String);
  const missingSkills = skills.filter((skill) => !skillNames.includes(skill));
  if (missingSkills.length > 0) errors.push(`Skills that do not exist: ${missingSkills.join(", ")}.`);
  const subagents = (Array.isArray(input?.subagents) ? input.subagents : []).map(String);
  const missingAgents = subagents.filter((agent) => !agentNames.includes(agent));
  if (missingAgents.length > 0) errors.push(`Agents that do not exist: ${missingAgents.join(", ")}.`);
  if (input?.effort !== undefined && input.effort !== "" && !EFFORTS.includes(input.effort)) errors.push("Effort is low, medium or high.");
  if (name && (agentNames.includes(name) || await readFile(join(etn, "prompts", `${name}.md`), "utf8").then(() => true, () => false))) {
    throw Object.assign(new Error(`An agent or prompt called '${name}' already exists.`), { statusCode: 409 });
  }
  if (errors.length > 0) throw Object.assign(new Error(errors[0]), { statusCode: 400, details: { errors } });

  // Skills it has are opened with load_skill, and handing work on needs spawn_subagent.
  const tools = [...new Set([...asked, ...(skills.length > 0 ? ["load_skill"] : []), ...(subagents.length > 0 ? ["spawn_subagent"] : [])])];
  const description = typeof input?.description === "string" ? input.description.trim().slice(0, 240) : "";
  const manifest = YAML.stringify({
    name,
    ...(description ? { description } : {}),
    promptRef: name,
    skills,
    requires: ["chat"],
    subagents,
    ...(EFFORTS.includes(input?.effort) ? { effort: input.effort } : {}),
  }).trimEnd() + "\n" + YAML.stringify({ tools }, { flowCollectionPadding: false }).trimEnd();
  await mkdir(join(etn, "prompts"), { recursive: true });
  await mkdir(join(etn, "agents"), { recursive: true });
  await writeFile(join(etn, "prompts", `${name}.md`), `${prompt}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(join(etn, "agents", `${name}.yaml`), `# Created in the page. Read it, then lock it under Content.\n${manifest}\n`, { encoding: "utf8", flag: "wx" });
  return { name, path: `.etnpilot/agents/${name}.yaml`, promptPath: `.etnpilot/prompts/${name}.md`, unreviewed: true };
}
