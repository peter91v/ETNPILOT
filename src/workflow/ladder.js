// @ts-check
import { parseVerdict, QUORUM_INSTRUCTION } from "./quorum.js";

// A ladder step: the cheapest tier tries the task, the result is verified, and a
// failed verification moves the task up one tier with the failure report as
// feedback. The expensive model is the last rung, not the first.
//
//   - id: build
//     type: ladder
//     agent: builder
//     tiers:
//       - { model: claude-haiku-4-5-20251001, effort: low }
//       - { model: claude-sonnet-5-5, effort: medium }
//       - { model: claude-opus-5-5, effort: high }
//     verify: [{ command: npm test }, { reviewer: reviewer }]
//     router: { agent: triage }        # optional: pick the first rung and how hard to verify
//
// Everything here is orchestration; running an agent, a command or a reviewer is
// handed in, so the step can be tested without a model.

export const LADDER_LIMITS = Object.freeze({ tiers: 6, verifiers: 4, feedbackChars: 2400 });
const EFFORTS = ["low", "medium", "high"];

export const TRIAGE_INSTRUCTION = `Classify the task above; do not do it. Answer with one JSON object and nothing else:
{"difficulty": "simple" | "medium" | "complex", "risk": "low" | "high", "reason": "one sentence"}
"simple" is a small, local change. "complex" needs design across several files or careful reasoning.
"high" risk means a mistake would be costly or hard to see (security, data, public interfaces, migrations).`;

// Validation for the workflow file; writes the cleaned step into `out`.
export function cleanLadder(step, { id, known, errors, out }) {
  if (typeof step.agent !== "string" || !step.agent) errors.push(`'${id}' needs an agent.`);
  else if (known.size > 0 && !known.has(step.agent)) errors.push(`'${id}' names the agent '${step.agent}', which does not exist.`);
  else out.agent = step.agent;

  const tiers = Array.isArray(step.tiers) ? step.tiers : [];
  if (tiers.length === 0) errors.push(`'${id}' needs at least one tier (a model and an effort to try).`);
  if (tiers.length > LADDER_LIMITS.tiers) errors.push(`'${id}' has more than ${LADDER_LIMITS.tiers} tiers.`);
  out.tiers = [];
  for (const [index, tier] of tiers.slice(0, LADDER_LIMITS.tiers).entries()) {
    const label = `'${id}' tier ${index + 1}`;
    if (!tier || typeof tier !== "object") { errors.push(`${label} must say a model, a provider or an effort.`); continue; }
    const clean = {};
    if (tier.provider !== undefined) {
      if (typeof tier.provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tier.provider)) errors.push(`${label}: 'provider' must be the name of a configured provider.`);
      else clean.provider = tier.provider;
    }
    if (tier.model !== undefined) {
      if (typeof tier.model !== "string" || !/^[A-Za-z0-9._:/-]{1,100}$/.test(tier.model)) errors.push(`${label}: 'model' is not a model id.`);
      else clean.model = tier.model;
    }
    if (tier.effort !== undefined) {
      if (!EFFORTS.includes(tier.effort)) errors.push(`${label}: 'effort' must be low, medium or high.`);
      else clean.effort = tier.effort;
    }
    if (Object.keys(clean).length === 0) errors.push(`${label} changes nothing: give a model, a provider or an effort.`);
    out.tiers.push(clean);
  }

  const verify = cleanVerifiers(step.verify, { id, known, errors, name: "verify" });
  if (verify.length === 0) errors.push(`'${id}' needs something to verify with: a command (for example npm test) or a reviewer agent.`);
  out.verify = verify;
  if (step.verifyLight !== undefined) out.verifyLight = cleanVerifiers(step.verifyLight, { id, known, errors, name: "verifyLight" });

  if (step.router !== undefined) {
    if (!step.router || typeof step.router.agent !== "string" || !step.router.agent) errors.push(`'${id}' router needs an agent that classifies the task.`);
    else if (known.size > 0 && !known.has(step.router.agent)) errors.push(`'${id}' router names the agent '${step.router.agent}', which does not exist.`);
    else out.router = { agent: step.router.agent };
  }
  if (step.baseline !== undefined) {
    if (typeof step.baseline !== "boolean") errors.push(`'${id}' baseline must be true or false.`);
    else out.baseline = step.baseline;
  }
  if (step.maxAttempts !== undefined) {
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > LADDER_LIMITS.tiers) errors.push(`'${id}' maxAttempts must be a number from 1 to ${LADDER_LIMITS.tiers}.`);
    else out.maxAttempts = step.maxAttempts;
  }
}

function cleanVerifiers(list, { id, known, errors, name }) {
  const cleaned = [];
  const entries = Array.isArray(list) ? list : [];
  if (entries.length > LADDER_LIMITS.verifiers) errors.push(`'${id}' ${name} has more than ${LADDER_LIMITS.verifiers} entries.`);
  for (const entry of entries.slice(0, LADDER_LIMITS.verifiers)) {
    if (entry && typeof entry === "object" && entry.command !== undefined) {
      const command = Array.isArray(entry.command) ? entry.command : typeof entry.command === "string" ? entry.command.trim().split(/\s+/) : [];
      if (command.length === 0 || command.length > 20 || command.some((part) => typeof part !== "string" || part === "")) errors.push(`'${id}' ${name}: a command is something like npm test.`);
      else cleaned.push({ command, ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim().slice(0, 80) } : {}) });
    } else if (entry && typeof entry === "object" && typeof entry.reviewer === "string") {
      if (known.size > 0 && !known.has(entry.reviewer)) errors.push(`'${id}' ${name}: the reviewer '${entry.reviewer}' is not an agent of this project.`);
      else cleaned.push({ reviewer: entry.reviewer });
    } else {
      errors.push(`'${id}' ${name}: each entry is { command: ... } or { reviewer: <agent> }.`);
    }
  }
  return cleaned;
}

// Which rung to start on and how hard to verify, from the classifier's answer.
// An answer that cannot be read is never an excuse to skip checking: unknown
// risk verifies fully, unknown difficulty starts at the bottom (the ladder
// climbs by itself if that was wrong).
export function parseTriage(text) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ""));
  let data = {};
  if (match) {
    try { data = JSON.parse(match[0]); } catch { data = {}; }
  }
  const difficulty = ["simple", "medium", "complex"].includes(data.difficulty) ? data.difficulty : "unknown";
  const risk = data.risk === "low" ? "low" : "high";
  return { difficulty, risk, reason: typeof data.reason === "string" ? data.reason.slice(0, 300) : undefined };
}

export function startTier(triage, tierCount) {
  if (triage.difficulty === "complex") return tierCount - 1;
  if (triage.difficulty === "medium") return Math.min(tierCount - 1, Math.floor(tierCount / 2));
  return 0;
}

// A failure no stronger model can fix: the tool is missing, the dependencies or
// the browser are not there. Only trusted before any change was made; afterwards
// the same words can be the agent's own mistake.
const ENVIRONMENT_FAILURE = /was not found|could not be (run|executed)|could not start|command not found|ENOENT|Cannot find module|node_modules|No binary for|Cannot start Chrome\w*|Missing X server|no display|ECONNREFUSED/i;

export function isEnvironmentFailure(outcome) {
  return outcome.code === 126 || outcome.code === 127 || ENVIRONMENT_FAILURE.test(String(outcome.detail ?? ""));
}

// The same failure with its numbers (timings, counts, ports) blanked, so two
// tiers failing alike compare equal.
const signature = (name, detail) => `${name}\u0000${String(detail ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim()}`;

const money = (value) => (typeof value === "number" ? value : 0);

// deps: runAgent(tier, input) -> receipt, verifyCommand(verifier) -> {ok, detail},
// runReviewer(name, input) -> receipt, runTriage(input) -> receipt, record(entry)
/**
 * @param {any} step
 * @param {{ input: string, runAgent: (tier: any, input: string) => Promise<any>, verifyCommand: (verifier: any) => Promise<{ ok: boolean, detail?: string }>, runReviewer: (name: string, input: string) => Promise<any>, runTriage?: (input: string) => Promise<any>, checkBaseline?: (verifiers: any[]) => Promise<{ ok: boolean, name?: string, detail?: string, code?: number }>, record?: (entry: any) => Promise<any>, signal?: AbortSignal }} deps
 */
export async function runLadder(step, { input, runAgent, verifyCommand, runReviewer, runTriage, checkBaseline, record = async () => {}, signal }) {
  const attempts = [];
  let route;
  let first = 0;
  let verifiers = step.verify;
  if (step.router && runTriage) {
    const triage = parseTriage((await runTriage(`${input}\n\n${TRIAGE_INSTRUCTION}`)).result?.text);
    first = startTier(triage, step.tiers.length);
    if (triage.risk === "low" && step.verifyLight?.length > 0) verifiers = step.verifyLight;
    route = { ...triage, startTier: first, verify: verifiers === step.verify ? "full" : "light" };
    await record({ type: "ladder-route", step: step.id, ...route });
  }
  // The checks on the untouched workspace, once. A tool or a browser that is
  // not there fails every tier alike; that is found here, for the price of one
  // check, and not after three models have tried. A check that fails on honest
  // grounds (the task is to make it pass) is only noted and the work goes on.
  let baseline;
  if (checkBaseline && step.baseline !== false && verifiers.some((verifier) => verifier.command)) {
    const result = await checkBaseline(verifiers.filter((verifier) => verifier.command));
    baseline = { ok: result.ok, ...(result.ok ? {} : { name: result.name, environment: isEnvironmentFailure(result) }) };
    await record({ type: "ladder-baseline", step: step.id, ...baseline, ...(result.ok ? {} : { detail: String(result.detail ?? "").slice(-LADDER_LIMITS.feedbackChars) }) });
    if (!result.ok && baseline.environment) {
      const error = new Error(`'${step.id}': the check '${result.name}' cannot run here, before any change was made, so no tier was tried.\n${result.detail ?? ""}`);
      Object.assign(error, { code: "ladder_environment", ladder: summarize(step, [], route, false) });
      throw error;
    }
  }
  const limit = Math.min(step.maxAttempts ?? step.tiers.length, step.tiers.length - first);
  let feedback = baseline && !baseline.ok ? "\n\n(Note: the check '" + baseline.name + "' already failed before any change was made.)" : "";
  let previous;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    signal?.throwIfAborted();
    const tierIndex = first + attempt;
    const tier = step.tiers[tierIndex];
    const entry = { tier: tierIndex + 1, ...tier, status: "failed", cost: 0, inputTokens: 0, outputTokens: 0, verify: /** @type {any[]} */ ([]) };
    let receipt;
    try {
      receipt = await runAgent({ ...tier, index: tierIndex }, `${input}${feedback}`);
    } catch (error) {
      entry.status = "error";
      entry.error = String(error.message ?? error).slice(0, 400);
      attempts.push(entry);
      await record({ type: "ladder-attempt", step: step.id, ...entry });
      feedback = feedbackFrom(`The previous attempt stopped with an error: ${entry.error}`);
      continue;
    }
    entry.cost += money(receipt.usage?.estimatedCost);
    entry.inputTokens += receipt.usage?.inputTokens ?? 0;
    entry.outputTokens += receipt.usage?.outputTokens ?? 0;
    entry.runId = receipt.runId;
    let failure;
    for (const verifier of verifiers) {
      let outcome;
      if (verifier.command) {
        outcome = await verifyCommand(verifier);
        entry.verify.push({ kind: "command", name: verifier.name ?? verifier.command.join(" "), ok: outcome.ok });
      } else {
        const review = await runReviewer(verifier.reviewer, `${input}\n\nThe work was done by another agent; review what it changed in the workspace.\n\n${QUORUM_INSTRUCTION}`);
        entry.cost += money(review.usage?.estimatedCost);
        entry.inputTokens += review.usage?.inputTokens ?? 0;
        entry.outputTokens += review.usage?.outputTokens ?? 0;
        const verdict = parseVerdict(review.result?.text);
        outcome = { ok: verdict === "approve", detail: String(review.result?.text ?? "").slice(-LADDER_LIMITS.feedbackChars) };
        entry.verify.push({ kind: "reviewer", name: verifier.reviewer, ok: outcome.ok, verdict });
      }
      if (!outcome.ok) { failure = { name: entry.verify.at(-1).name, detail: outcome.detail, code: outcome.code, command: Boolean(verifier.command) }; break; }
    }
    if (!failure) {
      entry.status = "passed";
      attempts.push(entry);
      await record({ type: "ladder-attempt", step: step.id, ...entry });
      return { ...receipt, ladder: summarize(step, attempts, route, true) };
    }
    attempts.push(entry);
    await record({ type: "ladder-attempt", step: step.id, ...entry });
    // The same command failing the same way on two tiers in a row: the stronger
    // model changed nothing about it, and a third would not either.
    const now = signature(failure.name, failure.detail);
    const stuck = failure.command && now === previous;
    previous = now;
    if (stuck && attempt < limit - 1) {
      const error = new Error(`'${step.id}' stopped after ${attempts.length} tier(s): '${failure.name}' fails in exactly the same way on two tiers in a row, so a stronger model is not changing it. If this is the environment (a missing browser or tool), fix that first.\n${String(failure.detail ?? "").slice(-LADDER_LIMITS.feedbackChars)}`);
      Object.assign(error, { code: "ladder_stuck", ladder: summarize(step, attempts, route, false) });
      throw error;
    }
    feedback = feedbackFrom(`Verification '${failure.name}' failed after the previous attempt.\n${failure.detail ?? ""}`);
  }
  const error = new Error(`'${step.id}' did not pass verification on any of ${attempts.length} tier(s).`);
  Object.assign(error, { code: "ladder_exhausted", ladder: summarize(step, attempts, route, false) });
  throw error;
}

function feedbackFrom(text) {
  return `\n\n--- A previous attempt did not pass ---\n${String(text).slice(-LADDER_LIMITS.feedbackChars)}\nThe workspace still holds what that attempt changed. Fix it; do not start over unless that is the better way.`;
}

function summarize(step, attempts, route, passed) {
  return {
    step: step.id,
    passed,
    ...(route ? { route } : {}),
    attempts: attempts.map(({ tier, provider, model, effort, status, cost, inputTokens, outputTokens, verify, error }) => ({ tier, provider, model, effort, status, cost, inputTokens, outputTokens, verify, ...(error ? { error } : {}) })),
    cost: attempts.reduce((sum, entry) => sum + entry.cost, 0),
  };
}
