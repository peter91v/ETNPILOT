// The ladder step on the page: an editor for building one in the workflow
// builder, and a flow picture that shows the same ladder, or the path a run
// actually took through it (which rung answered, what it cost, where the
// verification failed). The picture is drawn from the step or from the
// receipt's ladder entries; it states nothing the data does not.

const SVG_NS = "http://www.w3.org/2000/svg";
const TIER_PRESETS = [
  { model: "claude-haiku-4-5-20251001", effort: "low" },
  { model: "claude-sonnet-5-5", effort: "medium" },
  { model: "claude-opus-5-5", effort: "high" },
];

function ladderDefaults(agents) {
  return { agent: agents[0] ?? "", tiers: TIER_PRESETS.map((tier) => ({ ...tier })), verify: [{ command: "npm test" }] };
}

// ------------------------------------------------------------------ the editor

function ladderEditor(card, step, index, agents, redraw) {
  card.append(selectField("step-agent-" + index, "Agent that does the work", step.agent ?? "", agents.map((name) => [name, name]), (value) => { step.agent = value; }));

  card.append(el("p", { class: "muted", text: "Tiers, cheapest first. A failed check moves the task to the next one." }));
  step.tiers ??= [];
  step.tiers.forEach((tier, position) => {
    const row = el("div", { class: "ladder-row" });
    row.append(el("span", { class: "builder-num", text: String(position + 1) }));
    // The list is the models of the provider this tier would use: its own, else
    // the agent's, else the project's default.
    row.append(comboField("tier-model-" + index + "-" + position, "Model", tier.model ?? "", {
      onInput: (value) => { tier.model = value.trim() || undefined; },
      placeholder: "model id",
      load: () => modelIdsFor(effectiveChoice({ agent: step.agent, provider: tier.provider })?.provider),
    }));
    row.append(field("tier-provider-" + index + "-" + position, "Provider (optional)", tier.provider ?? "", (value) => { tier.provider = value.trim() || undefined; }, "as in providers"));
    row.append(selectField("tier-effort-" + index + "-" + position, "Effort", tier.effort ?? "", [["", "the agent's own"], ["low", "low"], ["medium", "medium"], ["high", "high"]], (value) => { tier.effort = value || undefined; }));
    row.append(button("Remove", { class: "btn link", onClick: () => { step.tiers.splice(position, 1); redraw(); } }));
    card.append(row);
  });
  if (step.tiers.length < 6) card.append(button("Add a tier", { class: "btn small", onClick: () => { step.tiers.push({ model: "", effort: "high" }); redraw(); } }));

  card.append(el("p", { class: "muted", text: "Every result is checked with:" }));
  verifierRows(card, step, "verify", index, agents, redraw);

  const routed = Boolean(step.router);
  card.append(checkField("step-router-" + index, "Let a triage agent pick the first tier and how hard to check (cheap model, no tools)", routed, (on) => {
    step.router = on ? { agent: agents[0] ?? "" } : undefined;
    if (!on) step.verifyLight = undefined;
    redraw();
  }));
  if (routed) {
    card.append(selectField("step-triage-" + index, "Triage agent", step.router.agent ?? "", agents.map((name) => [name, name]), (value) => { step.router.agent = value; }));
    card.append(el("p", { class: "muted", text: "For work it rates low risk, check only with (otherwise everything above runs; an unclear answer always runs everything):" }));
    step.verifyLight ??= [];
    verifierRows(card, step, "verifyLight", index, agents, redraw);
  }
  card.append(ladderDiagram(step));
}

function verifierRows(card, step, key, index, agents, redraw) {
  step[key] ??= [];
  step[key].forEach((verifier, position) => {
    const isReviewer = verifier.reviewer !== undefined;
    const row = el("div", { class: "ladder-row" });
    row.append(selectField(key + "-kind-" + index + "-" + position, "Kind", isReviewer ? "reviewer" : "command", [["command", "A command"], ["reviewer", "A reviewer agent"]], (value) => {
      step[key][position] = value === "reviewer" ? { reviewer: agents[0] ?? "" } : { command: "npm test" };
      redraw();
    }));
    if (isReviewer) row.append(selectField(key + "-agent-" + index + "-" + position, "Reviewer", verifier.reviewer, agents.map((name) => [name, name]), (value) => { verifier.reviewer = value; }));
    else row.append(field(key + "-cmd-" + index + "-" + position, "Command", Array.isArray(verifier.command) ? verifier.command.join(" ") : (verifier.command ?? ""), (value) => { verifier.command = value; }, "npm test"));
    row.append(button("Remove", { class: "btn link", onClick: () => { step[key].splice(position, 1); redraw(); } }));
    card.append(row);
  });
  if (step[key].length < 4) card.append(button("Add a check", { class: "btn small", onClick: () => { step[key].push({ command: "npm test" }); redraw(); } }));
}

// --------------------------------------------------------------- the flow picture

function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function shorten(text, max) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function dollars(value) {
  return typeof value === "number" ? "$" + value.toFixed(value < 0.1 ? 4 : 2) : "";
}

// spec: { tiers: [{model, provider, effort}], router?: {agent}, verify?: [...], run?: { attempts, route } }
// With a run, each tier shows what happened to it; without, the plan.
function ladderDiagram(spec) {
  const tiers = (spec.run && spec.run.attempts.length > 0 ? spec.run.attempts : spec.tiers ?? []).filter(Boolean);
  const routed = Boolean(spec.router) || Boolean(spec.run?.route);
  const top = routed ? 98 : 50;
  const pitch = 84;
  const height = top + tiers.length * pitch + 20;
  const svg = svgNode("svg", { viewBox: "0 0 360 " + height, class: "ladder-flow", role: "img" });
  svg.append(svgNode("title", {}, "Ladder: " + tiers.length + " tier" + (tiers.length === 1 ? "" : "s")));

  // The request, and the router when there is one.
  svg.append(svgNode("rect", { x: 8, y: 8, width: 70, height: 28, rx: 14, class: "lf-node" }));
  svg.append(svgNode("text", { x: 43, y: 26, class: "lf-text center" }, "Task"));
  svg.append(svgNode("path", { d: "M43 36 V" + (routed ? 48 : top - 2), class: "lf-line" }));
  if (routed) {
    const route = spec.run?.route;
    svg.append(svgNode("rect", { x: 8, y: 48, width: 344, height: 40, rx: 12, class: "lf-node" }));
    svg.append(svgNode("text", { x: 20, y: 65, class: "lf-text" }, "Router" + (spec.router?.agent ? " · " + shorten(spec.router.agent, 20) : "")));
    svg.append(svgNode("text", { x: 20, y: 81, class: "lf-sub" }, route ? shorten(route.difficulty + " · " + route.risk + " risk → tier " + (route.startTier + 1) + " · " + route.verify + " check", 44) : "picks the first tier and how hard to check"));
    svg.append(svgNode("path", { d: "M43 88 V" + (top - 2), class: "lf-line" }));
  }

  tiers.forEach((tier, position) => {
    const y = top + position * pitch;
    const status = tier.status ?? "plan";
    const number = tier.tier ?? position + 1;
    svg.append(svgNode("rect", { x: 8, y, width: 196, height: 54, rx: 12, class: "lf-tier " + status }));
    svg.append(svgNode("text", { x: 20, y: y + 19, class: "lf-text" }, "Tier " + number + (tier.effort ? " · " + tier.effort : "")));
    svg.append(svgNode("text", { x: 20, y: y + 36, class: "lf-sub" }, shorten(tier.model ?? tier.provider ?? "the agent's own model", 30)));
    if (spec.run) svg.append(svgNode("text", { x: 20, y: y + 50, class: "lf-sub" }, [dollars(tier.cost), status === "error" ? "error" : ""].filter(Boolean).join(" · ")));
    // Verification and the way out on a pass.
    const checked = status === "passed" || status === "failed" || status === "plan";
    svg.append(svgNode("path", { d: "M204 " + (y + 27) + " H222", class: "lf-line" }));
    svg.append(svgNode("rect", { x: 222, y: y + 13, width: 62, height: 28, rx: 14, class: "lf-pill" + (status === "failed" || status === "error" ? " bad" : status === "passed" ? " ok" : "") }));
    svg.append(svgNode("text", { x: 253, y: y + 31, class: "lf-text center" }, checked ? "verify" : "—"));
    svg.append(svgNode("path", { d: "M284 " + (y + 27) + " H318", class: "lf-line" + (status === "passed" ? " ok" : "") }));
    svg.append(svgNode("circle", { cx: 334, cy: y + 27, r: 16, class: "lf-end" + (status === "passed" ? " ok" : "") }));
    svg.append(svgNode("text", { x: 334, y: y + 32, class: "lf-text center" }, status === "passed" ? "✓" : spec.run ? "" : "done"));
    // Down to the next tier on a failed check; the last one stops the step.
    if (position < tiers.length - 1) {
      svg.append(svgNode("path", { d: "M253 " + (y + 41) + " V" + (y + pitch - 6) + " H206 M212 " + (y + pitch - 11) + " L206 " + (y + pitch - 6) + " L212 " + (y + pitch - 1), class: "lf-line fail" + (status === "failed" || status === "error" ? " taken" : "") }));
    } else {
      if (status !== "passed") svg.append(svgNode("text", { x: 253, y: y + 60, class: "lf-sub center" }, status === "failed" || status === "error" ? "step fails" : "if it fails: step fails"));
    }
  });
  const holder = el("div", { class: "ladder-flow-box" });
  holder.append(svg);
  const checks = (spec.verify ?? []).map((verifier) => verifier.reviewer ? "reviewer " + verifier.reviewer : (Array.isArray(verifier.command) ? verifier.command.join(" ") : verifier.command)).filter(Boolean);
  if (checks.length > 0 && !spec.run) holder.append(el("p", { class: "muted", text: "Checked with: " + checks.join(", ") + "." }));
  return holder;
}

// The path a run took through a ladder step, from its receipt.
function ladderRunPanels(receipt) {
  const entries = receipt.entries ?? [];
  const steps = new Map();
  for (const entry of entries) {
    if (entry.type !== "ladder-attempt" && entry.type !== "ladder-route") continue;
    const group = steps.get(entry.step) ?? { attempts: [], route: undefined };
    if (entry.type === "ladder-route") group.route = entry;
    else group.attempts.push(entry);
    steps.set(entry.step, group);
  }
  const parts = [];
  for (const [id, run] of steps) {
    const total = run.attempts.reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0);
    const passed = run.attempts.find((attempt) => attempt.status === "passed");
    parts.push(el("p", { class: "muted", text: "Ladder '" + id + "' · " + (passed ? "passed on tier " + passed.tier : "no tier passed") + (total > 0 ? " · " + dollars(total) : "") }));
    parts.push(ladderDiagram({ tiers: [], run }));
  }
  return parts;
}
