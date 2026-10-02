// @ts-check
import YAML from "yaml";

// A named workflow: a file under '.etnpilot/workflows/' holding the steps a run
// goes through. It is project content like an agent or a prompt — read, pinned
// by 'etnpilot content lock', committed — so a workflow nobody reviewed cannot
// slip a step out, or a gate, from one that somebody did.
//
// The same check runs where a workflow is made (the page), where it is loaded
// (a run) and in tests. It says what is wrong in the words of the step.

export const STEP_TYPES = Object.freeze(["agent", "check", "gate", "quorum"]);
const LIMITS = Object.freeze({ steps: 30, id: 40, text: 400, command: 20 });

export function slugName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

// Returns { ok, errors, workflow }: 'workflow' is the cleaned definition,
// holding only fields a step is known to use.
export function validateWorkflowDefinition(input, { agents = [], maxSteps = 50 } = /** @type {any} */ ({})) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["The workflow must be an object with a name and steps."] };
  }
  const name = slugName(input.name);
  if (!name) errors.push("A workflow needs a name (letters, digits, dashes).");
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length === 0) errors.push("A workflow needs at least one step.");
  if (steps.length > Math.min(LIMITS.steps, maxSteps)) errors.push(`A workflow has at most ${Math.min(LIMITS.steps, maxSteps)} steps.`);

  const known = new Set(agents);
  const cleaned = [];
  const ids = new Set();
  for (const [index, step] of steps.slice(0, LIMITS.steps).entries()) {
    const label = `Step ${index + 1}`;
    const id = typeof step?.id === "string" ? step.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id)) { errors.push(`${label} needs an id of letters, digits, dashes (up to ${LIMITS.id}).`); continue; }
    if (ids.has(id)) { errors.push(`Two steps are called '${id}'.`); continue; }
    ids.add(id);
    const type = step.type ?? "agent";
    if (!STEP_TYPES.includes(type)) { errors.push(`'${id}' has type '${type}'; use agent, check, gate or quorum.`); continue; }
    const out = { id, type };
    if (Array.isArray(step.needs) && step.needs.length > 0) out.needs = step.needs.map(String);
    STEP_CLEANERS[type](step, { id, known, errors, out });
    cleaned.push(out);
  }
  for (const step of cleaned) {
    for (const dependency of step.needs ?? []) {
      if (!ids.has(dependency)) errors.push(`'${step.id}' needs '${dependency}', which is not a step of this workflow.`);
      if (dependency === step.id) errors.push(`'${step.id}' cannot wait for itself.`);
    }
  }
  if (errors.length === 0 && hasCycle(cleaned)) errors.push("The steps wait for each other in a circle.");

  const workflow = {
    name,
    ...(typeof input.description === "string" && input.description.trim() ? { description: input.description.trim().slice(0, LIMITS.text) } : {}),
    steps: cleaned,
  };
  return { ok: errors.length === 0, errors, workflow };
}

// What each kind of step keeps, and what is wrong with it. They write into
// `out` (the cleaned step) and `errors`.
const STEP_CLEANERS = {
  agent(step, { id, known, errors, out }) {
    if (typeof step.agent !== "string" || !step.agent) errors.push(`'${id}' needs an agent.`);
    else if (known.size > 0 && !known.has(step.agent)) errors.push(`'${id}' names the agent '${step.agent}', which does not exist.`);
    else out.agent = step.agent;
    if (step.expect !== undefined) {
      if (step.expect !== "tool-use") errors.push(`'${id}' expects '${step.expect}'; the only expectation is 'tool-use'.`);
      else out.expect = "tool-use";
    }
  },
  quorum(step, { id, known, errors, out }) {
    const list = Array.isArray(step.agents) ? step.agents.map(String) : [];
    if (list.length < 2) errors.push(`'${id}' needs at least two agents to compare.`);
    const missing = list.filter((agent) => known.size > 0 && !known.has(agent));
    if (missing.length > 0) errors.push(`'${id}' names agents that do not exist: ${missing.join(", ")}.`);
    out.agents = list;
    if (step.required !== undefined) {
      if (!Number.isInteger(step.required) || step.required < 1 || step.required > list.length) errors.push(`'${id}' requires ${step.required} approvals of ${list.length} agents.`);
      else out.required = step.required;
    }
  },
  check(step, { id, errors, out }) {
    const command = Array.isArray(step.command) ? step.command : typeof step.command === "string" ? step.command.trim().split(/\s+/) : [];
    if (command.length === 0 || command.length > LIMITS.command || command.some((part) => typeof part !== "string" || part === "")) errors.push(`'${id}' needs a command, for example: npm test`);
    else out.command = command;
    if (typeof step.name === "string" && step.name.trim()) out.name = step.name.trim().slice(0, 80);
  },
  gate(step, { out }) {
    if (typeof step.prompt === "string" && step.prompt.trim()) out.prompt = step.prompt.trim().slice(0, LIMITS.text);
    if (step.questions === false) out.questions = false;
  },
};

function hasCycle(steps) {
  const indegree = new Map(steps.map((step) => [step.id, (step.needs ?? []).length]));
  const queue = steps.filter((step) => (step.needs ?? []).length === 0).map((step) => step.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const step of steps) {
      if (!(step.needs ?? []).includes(id)) continue;
      const left = indegree.get(step.id) - 1;
      indegree.set(step.id, left);
      if (left === 0) queue.push(step.id);
    }
  }
  return visited !== steps.length;
}

export function renderWorkflowFile(workflow, { note } = /** @type {any} */ ({})) {
  const header = note ? `# ${note}\n` : "";
  return `${header}${YAML.stringify(workflow, { lineWidth: 0 })}`;
}

export function parseWorkflowFile(content) {
  const data = YAML.parse(content);
  return data && typeof data === "object" ? data : undefined;
}
