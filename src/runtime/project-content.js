// @ts-check
import { swallow } from "./swallow.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
// Opening several files of one review in a row captured the whole project's
// content each time. A capture made a moment ago is good enough for showing a
// file; locking never uses this, it reads fresh.
const RECENT_MS = 1500;
const recentSnapshots = new Map();

async function recentSnapshot(root, config) {
  const key = resolve(root);
  const kept = recentSnapshots.get(key);
  if (kept && Date.now() - kept.at < RECENT_MS) return kept.snapshot;
  const snapshot = await captureProjectContent(root, normalizeContentProvenance(config ?? {}));
  recentSnapshots.set(key, { at: Date.now(), snapshot });
  if (recentSnapshots.size > 8) recentSnapshots.delete(recentSnapshots.keys().next().value);
  return snapshot;
}

export async function readContentFile({ root, config, path }) {
  const snapshot = await recentSnapshot(root, config);
  const item = snapshot.items.find((candidate) => candidate.path === path);
  if (!item) return undefined;
  return { type: item.type, name: item.name, path: item.path, digest: item.digest, content: item.content, ...(originOf(item.content) ? { origin: originOf(item.content) } : {}) };
}

// Locks exactly what was shown. The digest the person saw comes back with the
// request; if the content is not the same now, nothing is locked.
export async function lockReviewedContent({ root, config, manifestDigest }) {
  recentSnapshots.delete(resolve(root));
  const review = await readContentReview({ root, config });
  if (review.problem) throw Object.assign(new Error(review.problem), { statusCode: 409 });
  if (!manifestDigest || review.manifestDigest !== manifestDigest) throw new ContentChanged();
  await writeContentLock(root, config);
  return readContentReview({ root, config });
}

// ------------------------------------------------------------------ agents in detail

export async function readAgentDetails({ root, config }) {
  const etn = join(resolve(root), ".etnpilot");
  const review = await readContentReview({ root, config }).catch(swallow("content review", () => ({ items: [] })));
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
  const review = await readContentReview({ root, config }).catch(swallow("content review", () => ({ items: [] })));
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
  recentSnapshots.delete(resolve(root));
  const { agents } = await readAgentDetails({ root, config });
  const checked = validateWorkflowDefinition(input, { agents: agents.filter((agent) => !agent.error).map((agent) => agent.name), maxSteps: config?.workflow?.maxSteps ?? 50 });
  if (!checked.ok) {
    throw Object.assign(new Error(checked.errors[0]), { statusCode: 400, details: { errors: checked.errors } });
  }
  const directory = join(resolve(root), ".etnpilot", "workflows");
  await mkdir(directory, { recursive: true });
  const workflow = /** @type {any} */ (checked.workflow);
  const path = join(directory, `${workflow.name}.yaml`);
  const content = renderWorkflowFile(checked.workflow, { note: "Created in the page. Read it, then lock it with 'etnpilot content lock' (or in the Content view)." });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code === "EEXIST") throw Object.assign(new Error(`A workflow called '${workflow.name}' already exists.`), { statusCode: 409 });
    throw error;
  });
  return { name: workflow.name, path: `.etnpilot/workflows/${workflow.name}.yaml`, unreviewed: true };
}

// ------------------------------------------------------------------------ agents

const EFFORTS = ["low", "medium", "high"];

// An agent made in the page. 'tools' is always written: leaving it out means
// every tool, and a form that did that by omission would hand out the most
// when someone ticked nothing.
export async function createAgent({ root, config, input }) {
  recentSnapshots.delete(resolve(root));
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
  const skillNames = /** @type {import("node:fs").Dirent[]} */ (await readdir(join(etn, "skills"), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const agentNames = (await readdir(join(etn, "agents")).catch(() => [])).filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, ""));
  const skills = (Array.isArray(input?.skills) ? input.skills : []).map(String);
  const missingSkills = skills.filter((skill) => !skillNames.includes(skill));
  if (missingSkills.length > 0) errors.push(`Skills that do not exist: ${missingSkills.join(", ")}.`);
  const subagents = (Array.isArray(input?.subagents) ? input.subagents : []).map(String);
  const missingAgents = subagents.filter((agent) => !agentNames.includes(agent));
  if (missingAgents.length > 0) errors.push(`Agents that do not exist: ${missingAgents.join(", ")}.`);
  if (input?.effort !== undefined && input.effort !== "" && !EFFORTS.includes(input.effort)) errors.push("Effort is low, medium or high.");
  const { provider, model } = checkProviderInput(input, config, errors);
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
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }).trimEnd() + "\n" + YAML.stringify({ tools }, { flowCollectionPadding: false }).trimEnd();
  await mkdir(join(etn, "prompts"), { recursive: true });
  await mkdir(join(etn, "agents"), { recursive: true });
  await writeFile(join(etn, "prompts", `${name}.md`), `${prompt}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(join(etn, "agents", `${name}.yaml`), `# Created in the page. Read it, then lock it under Content.\n${manifest}\n`, { encoding: "utf8", flag: "wx" });
  return { name, path: `.etnpilot/agents/${name}.yaml`, promptPath: `.etnpilot/prompts/${name}.md`, unreviewed: true };
}

// ------------------------------------------------------------ change and remove

function ownName(name) {
  const slug = slugName(name);
  if (!slug || slug !== name) throw Object.assign(new Error("That is not a name of this project."), { statusCode: 400 });
  return slug;
}

// Rewrites an agent's manifest and prompt from the form, keeping what the form
// does not know about (provider, model, requires, the comment on the first
// line): the page edits what it shows and leaves the rest as it found it.
export async function updateAgent({ root, config, name, input }) {
  recentSnapshots.delete(resolve(root));
  ownName(name);
  const etn = join(resolve(root), ".etnpilot");
  const path = join(etn, "agents", `${name}.yaml`);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) throw Object.assign(new Error(`There is no agent called '${name}'.`), { statusCode: 404 });
  const asked = await checkAgentInput({ etn, name, input, config });

  const document = YAML.parseDocument(text);
  const current = document.toJS() ?? {};
  applyAgentInput(document, current, input, asked);
  await writeFile(path, String(document), "utf8");
  if (asked.prompt !== undefined) {
    const ref = typeof current.promptRef === "string" ? slugName(current.promptRef) : name;
    await mkdir(join(etn, "prompts"), { recursive: true });
    await writeFile(join(etn, "prompts", `${ref}.md`), `${asked.prompt}\n`, "utf8");
  }
  return { name, path: `.etnpilot/agents/${name}.yaml`, unreviewed: true };
}

// The provider and model an agent was given in the form: a provider the project
// configures and a model id, or empty for "the project's default". A model name
// belongs to one vendor, so a model without a provider is refused when the agent
// has none of its own to pair it with.
function checkProviderInput(input, config, errors) {
  const provider = typeof input?.provider === "string" ? input.provider.trim() : undefined;
  const model = typeof input?.model === "string" ? input.model.trim() : undefined;
  if (provider && !Object.hasOwn(config?.providers ?? {}, provider)) errors.push(`'${provider}' is not a provider of this project.`);
  if (model && !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) errors.push("That is not a model id.");
  return { provider, model };
}

// What the form asked for, refused with the first reason when any of it is
// wrong. Returns the values worth keeping: the prompt, the tools, the skills
// and the agents it may hand work to.
async function checkAgentInput({ etn, name, input, config }) {
  const known = WORKSPACE_TOOL_DEFINITIONS.map((definition) => definition.name);
  const errors = [];
  const prompt = typeof input?.prompt === "string" ? input.prompt.replace(/\r\n/g, "\n").trim() : undefined;
  if (prompt !== undefined && !prompt) errors.push("An agent needs a prompt.");
  if (prompt && prompt.length > 12_000) errors.push("The prompt is longer than 12,000 characters.");
  const tools = Array.isArray(input?.tools) ? input.tools.map(String) : undefined;
  if (tools) {
    const unknown = tools.filter((tool) => !known.includes(tool));
    if (unknown.length > 0) errors.push(`Unknown tools: ${unknown.join(", ")}.`);
  }
  const skillNames = /** @type {import("node:fs").Dirent[]} */ (await readdir(join(etn, "skills"), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const agentNames = (await readdir(join(etn, "agents")).catch(() => [])).filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, ""));
  const skills = Array.isArray(input?.skills) ? input.skills.map(String) : undefined;
  if (skills?.some((skill) => !skillNames.includes(skill))) errors.push(`Skills that do not exist: ${skills.filter((skill) => !skillNames.includes(skill)).join(", ")}.`);
  const subagents = Array.isArray(input?.subagents) ? input.subagents.map(String) : undefined;
  if (subagents?.some((agent) => !agentNames.includes(agent))) errors.push(`Agents that do not exist: ${subagents.filter((agent) => !agentNames.includes(agent)).join(", ")}.`);
  if (subagents?.includes(name)) errors.push("An agent cannot hand work to itself.");
  if (subagents && !subagents.includes(name)) {
    const loop = await handingInCircle({ etn, name, subagents, agentNames });
    if (loop) errors.push(`'${loop}' already hands work on to '${name}': that would go round in a circle.`);
  }
  if (input?.effort !== undefined && input.effort !== "" && !EFFORTS.includes(input.effort)) errors.push("Effort is low, medium or high.");
  const { provider, model } = checkProviderInput(input, config, errors);
  if (errors.length > 0) throw Object.assign(new Error(errors[0]), { statusCode: 400, details: { errors } });
  return { prompt, tools, skills, subagents, provider, model };
}

// Work handed round in a circle would never end: the agent that closes one, if
// the new list would.
async function handingInCircle({ etn, name, subagents, agentNames }) {
  const graph = new Map();
  for (const other of agentNames) {
    if (other === name) { graph.set(other, subagents); continue; }
    const text = await readFile(join(etn, "agents", `${other}.yaml`), "utf8").catch(() => "");
    graph.set(other, (YAML.parse(text)?.subagents ?? []).map(String));
  }
  const reaches = (from, target, seen = new Set()) => from === target || (!seen.has(from) && seen.add(from) && (graph.get(from) ?? []).some((next) => reaches(next, target, seen)));
  return subagents.find((next) => (graph.get(next) ?? []).some((after) => reaches(after, name)));
}

function applyAgentInput(document, current, input, { tools: asked, skills, subagents, provider, model }) {
  const finalSkills = skills ?? current.skills ?? [];
  const finalSubagents = subagents ?? current.subagents ?? [];
  if (typeof input?.description === "string") {
    if (input.description.trim()) document.set("description", input.description.trim().slice(0, 240)); else document.delete("description");
  }
  if (skills) document.set("skills", skills);
  if (subagents) document.set("subagents", subagents);
  if (input?.effort !== undefined) {
    if (EFFORTS.includes(input.effort)) document.set("effort", input.effort); else document.delete("effort");
  }
  // Empty means "the project's own", so the line goes.
  if (provider !== undefined) { if (provider) document.set("provider", provider); else document.delete("provider"); }
  if (model !== undefined) { if (model) document.set("model", model); else document.delete("model"); }
  // Handing work on needs the tool to do it, whichever way the list arrived; an
  // agent with no list of tools already has every one.
  const base = asked ?? (Array.isArray(current.tools) ? current.tools.map(String) : undefined);
  if (!base) return;
  const tools = [...new Set([...base, ...(finalSkills.length > 0 ? ["load_skill"] : []), ...(finalSubagents.length > 0 ? ["spawn_subagent"] : [])])];
  if (asked || tools.length !== base.length) {
    const node = document.createNode(tools);
    node.flow = true;
    document.set("tools", node);
  }
}

export async function updateWorkflow({ root, config, name, input }) {
  recentSnapshots.delete(resolve(root));
  ownName(name);
  const path = join(resolve(root), ".etnpilot", "workflows", `${name}.yaml`);
  if (await readFile(path, "utf8").then(() => false, () => true)) throw Object.assign(new Error(`There is no workflow called '${name}'.`), { statusCode: 404 });
  const { agents } = await readAgentDetails({ root, config });
  const checked = validateWorkflowDefinition({ ...input, name }, { agents: agents.filter((agent) => !agent.error).map((agent) => agent.name), maxSteps: config?.workflow?.maxSteps ?? 50 });
  if (!checked.ok) throw Object.assign(new Error(checked.errors[0]), { statusCode: 400, details: { errors: checked.errors } });
  await writeFile(path, renderWorkflowFile(checked.workflow, { note: "Edited in the page. Read it, then lock it under Content." }), "utf8");
  return { name, path: `.etnpilot/workflows/${name}.yaml`, unreviewed: true };
}

// Removes an agent (and its prompt, when nothing else uses it) or a workflow.
// Refused while something still points at it: a workflow that names a deleted
// agent, or an agent that hands work to one, would only fail at the next run.
export async function removeContent({ root, config, kind, name }) {
  recentSnapshots.delete(resolve(root));
  ownName(name);
  if (!["agent", "workflow"].includes(kind)) throw Object.assign(new Error("Only an agent or a workflow can be removed here."), { statusCode: 400 });
  const etn = join(resolve(root), ".etnpilot");
  if (kind === "workflow") {
    const path = join(etn, "workflows", `${name}.yaml`);
    if (await readFile(path, "utf8").then(() => false, () => true)) throw Object.assign(new Error(`There is no workflow called '${name}'.`), { statusCode: 404 });
    await rm(path);
    return { removed: [`.etnpilot/workflows/${name}.yaml`] };
  }
  const { agents } = await readAgentDetails({ root, config });
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent || agent.error) throw Object.assign(new Error(`There is no agent called '${name}'.`), { statusCode: agent?.error ? 409 : 404 });
  const blockers = [];
  for (const other of agents) if (other.name !== name && (other.subagents ?? []).includes(name)) blockers.push(`the agent '${other.name}' hands work to it`);
  const { workflows, configured } = await readWorkflows({ root, config });
  const uses = (steps) => (steps ?? []).some((step) => step.agent === name || (step.agents ?? []).includes(name));
  for (const workflow of workflows) if (uses(workflow.steps)) blockers.push(`the workflow '${workflow.name}' has a step for it`);
  if (uses(configured?.steps)) blockers.push("the workflow in etnpilot.yaml has a step for it");
  if (config?.defaultAgent === name) blockers.push("it is the project's default agent");
  if (blockers.length > 0) {
    throw Object.assign(new Error(`'${name}' is still in use: ${blockers.join("; ")}. Change that first.`), { statusCode: 409, details: { blockers } });
  }
  const removed = [agent.path];
  await rm(join(etn, "agents", agent.file));
  // The prompt goes with it unless another agent reads the same file.
  if (agent.promptPath && !agents.some((other) => other.name !== name && other.promptPath === agent.promptPath)) {
    await rm(join(resolve(root), agent.promptPath), { force: true });
    removed.push(agent.promptPath);
  }
  return { removed };
}
