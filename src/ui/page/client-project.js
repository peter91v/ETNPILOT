// The Agents and Content views, and the workflow builder.
// Client-side code, kept as text and joined by ../page.js into one script. It
// is not a module in the browser: no imports, no build step, and no
// backslashes or backticks in here, because this is a template literal.
//
// Content is what a run is allowed to use: agents, prompts, skills,
// instructions, workflows. A person reads it and locks it; a run refuses what
// is not locked. These views are where that reading happens on a phone.
export const CLIENT_PROJECT = `let contentData;
let agentData;
let workflowData;
let contentFilter = "review";
let openAgentName;
let projectError;

const TOOL_WORDS = {
  read_file: "reads files",
  list_files: "lists files",
  search_files: "searches files",
  write_file: "writes files",
  edit_file: "edits files",
  run_command: "runs commands",
  fetch_url: "reads web pages",
  load_skill: "opens its skills",
  propose_instruction: "proposes rules",
  spawn_subagent: "hands work to other agents",
  ask_human: "asks you",
};
const TOOLS_THAT_CHANGE = ["write_file", "edit_file", "run_command"];
const STEP_LABELS = { agent: "Agent", check: "Check", gate: "Your approval", quorum: "Agents compare" };
const TYPE_LABELS = { agent: "Agents", workflow: "Workflows", instruction: "Instructions", prompt: "Prompts", skill: "Skills" };

async function loadProjectViews({ notify = false } = {}) {
  const [content, agents, workflows] = await Promise.allSettled([api("/api/content"), api("/api/agents/detail"), api("/api/workflows")]);
  if (content.status === "fulfilled") contentData = content.value;
  if (agents.status === "fulfilled") agentData = agents.value;
  if (workflows.status === "fulfilled") workflowData = workflows.value;
  const failed = [content, agents, workflows].find((result) => result.status === "rejected");
  projectError = failed ? failed.reason.message : undefined;
  if (notify) toast(failed ? projectError : "Read again.", failed ? "bad" : "ok");
  if (view === "agents" || view === "content" || view === "overview") render();
}

function lockPill(status) {
  if (status === "locked") return pill("locked", "ok");
  if (status === "changed") return pill("changed since the lock", "warn");
  if (status === "new") return pill("not reviewed yet", "warn");
  return null;
}

function originPill(origin) {
  return origin ? pill(origin, "") : null;
}

function present(nodes) {
  return nodes.filter(Boolean);
}

// Who may hand work to this agent, as switches on the other agents: choosing
// one edits that agent's own list, which also gives it the tool to do it.
function handOverControls(agent) {
  const others = (agentData?.agents ?? []).filter((other) => !other.error && other.name !== agent.name);
  if (others.length === 0) return [];
  return [
    el("h5", { class: "card-h", text: "Who may hand work to it" }),
    ...others.map((other) => checkField("hand-" + agent.name + "-" + other.name, other.name, (other.subagents ?? []).includes(agent.name), async (on) => {
      const next = new Set(other.subagents ?? []);
      if (on) next.add(agent.name); else next.delete(agent.name);
      try {
        await api("/api/agents/" + encodeURIComponent(other.name), { method: "PUT", body: JSON.stringify({ subagents: [...next] }) });
        toast(on ? other.name + " may now hand work to " + agent.name + ". Unreviewed: lock it under Content." : other.name + " no longer hands work to " + agent.name + ".");
      } catch (error) {
        toast(error.message, "bad");
      }
      await loadProjectViews();
    })),
  ];
}

// A question that has to be answered before something is removed. Resolves to
// true or false; closing it any other way is a no.
function askConfirm({ title, text, yes }) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-yes").textContent = yes;
  openModal("confirm-modal");
  return new Promise((resolve) => {
    const done = (answer) => {
      $("confirm-yes").onclick = null;
      $("confirm-no").onclick = null;
      closeModal("confirm-modal");
      resolve(answer);
    };
    $("confirm-yes").onclick = () => done(true);
    $("confirm-no").onclick = () => done(false);
  });
}

async function removeNamed(kind, name, path) {
  const yes = await askConfirm({
    title: "Remove " + kind + " " + name + "?",
    text: "This deletes " + path + " from the project directory. If it was committed, git can bring it back; if not, it is gone. Content that other things still use is refused.",
    yes: "Remove",
  });
  if (!yes) return;
  try {
    await api("/api/" + (kind === "agent" ? "agents" : "workflows") + "/" + encodeURIComponent(name), { method: "DELETE" });
    toast("Removed " + name + ".");
    if (openAgentName === name) openAgentName = undefined;
    await loadProjectViews();
  } catch (error) {
    toast(error.message, "bad");
  }
}

// ------------------------------------------------------------------ Agents

function agentAbilities(agent) {
  if (agent.tools === null) return { text: "can use every tool", tone: "warn" };
  const changes = agent.tools.some((tool) => TOOLS_THAT_CHANGE.includes(tool));
  if (agent.tools.length === 0) return { text: "uses no tools: it only answers", tone: "ok" };
  return changes
    ? { text: "can change files or run commands", tone: "warn" }
    : { text: "only reads", tone: "ok" };
}

function renderAgents() {
  const host = $("view-agents");
  host.replaceChildren();
  if (projectError && !agentData) host.append(el("p", { class: "notice bad", text: projectError }));
  if (!agentData) {
    host.append(el("p", { class: "empty", text: "Reading the agents…" }));
    return;
  }
  const agents = agentData.agents ?? [];
  host.append(panel("Agents", {
    meta: button("New agent", { class: "btn tonal", onClick: () => openAgentBuilder() }),
    body: agents.length === 0
      ? [el("p", { class: "empty", text: "No agents yet. 'etnpilot forge' writes some for this repository, or add a manifest under .etnpilot/agents/." })]
      : agents.map(agentCard),
    open: true,
  }));
  host.append(workflowsPanel());
}

function agentCard(agent) {
  if (agent.error) {
    return el("article", { class: "card" }, [
      el("h4", { class: "card-title", text: agent.name }),
      el("p", { class: "notice bad", text: "This manifest does not parse: " + agent.error }),
    ]);
  }
  const abilities = agentAbilities(agent);
  const opened = openAgentName === agent.name;
  const head = el("button", { class: "card-head state", attrs: { type: "button", "aria-expanded": String(opened) } }, [
    el("span", { class: "card-main" }, [
      el("span", { class: "card-title", text: agent.name }),
      el("span", { class: "card-sub", text: agent.description ?? "No description." }),
    ]),
    el("span", { class: "card-chev", text: opened ? "▴" : "▾" }),
  ]);
  head.addEventListener("click", () => { openAgentName = opened ? undefined : agent.name; render(); });
  const chips = el("div", { class: "chips" }, present([
    pill(abilities.text, abilities.tone),
    agent.provider ? pill((agent.inheritedProvider ? "provider " : "provider ") + agent.provider + (agent.model ? " · " + agent.model : "")) : null,
    agent.effort ? pill("effort " + agent.effort) : null,
    lockPill(agent.lock),
    originPill(agent.origin),
  ]));
  const card = el("article", { class: opened ? "card open" : "card" }, [head, chips]);
  if (!opened) return card;

  const toolChips = agent.tools === null
    ? [pill("every tool", "warn")]
    : agent.tools.map((tool) => pill(TOOL_WORDS[tool] ?? tool, TOOLS_THAT_CHANGE.includes(tool) ? "warn" : ""));
  const detail = el("div", { class: "card-detail" }, [
    el("h5", { class: "card-h", text: "What it may do" }),
    el("div", { class: "chips" }, toolChips.length > 0 ? toolChips : [pill("nothing: it only answers")]),
    ...(agent.skills.length > 0 ? [el("h5", { class: "card-h", text: "Skills" }), el("div", { class: "chips" }, agent.skills.map((skill) => pill(skill)))] : []),
    ...(agent.subagents.length > 0 ? [el("h5", { class: "card-h", text: "Can hand work to" }), el("div", { class: "chips" }, agent.subagents.map((name) => pill(name)))] : []),
    ...(agent.usedBy.length > 0 ? [el("h5", { class: "card-h", text: "Handed work by" }), el("div", { class: "chips" }, agent.usedBy.map((name) => pill(name)))] : []),
    ...handOverControls(agent),
    el("h5", { class: "card-h", text: "What it is told" }),
    agent.prompt === undefined
      ? el("p", { class: "muted", text: "No prompt file found for " + (agent.promptRef ?? "this agent") + "." })
      : el("pre", { class: "scroll-pre", attrs: { tabindex: "0" }, text: agent.prompt + (agent.promptCut ? String.fromCharCode(10) + "[cut]" : "") }),
    el("p", { class: "muted mono", text: agent.path + (agent.promptPath ? "  ·  " + agent.promptPath : "") }),
    el("div", { class: "card-actions" }, [
      button("Remove", { class: "btn danger", onClick: () => removeNamed("agent", agent.name, agent.path) }),
      button("Edit", { class: "btn", onClick: () => openAgentBuilder(undefined, agent) }),
      button("Read the manifest", { class: "btn", onClick: () => openContentFile(agent.path) }),
      button("Start a run with it", { class: "btn tonal", onClick: () => startRunWith({ agent: agent.name }) }),
    ]),
  ]);
  card.append(detail);
  return card;
}

// ------------------------------------------------------------ agent builder

const AGENT_TOOL_GROUPS = [
  ["Read", [["read_file", "reads files"], ["list_files", "lists files"], ["search_files", "searches files"]]],
  ["Change", [["write_file", "writes files"], ["edit_file", "edits files"], ["run_command", "runs commands"]]],
  ["Other", [["fetch_url", "reads web pages"], ["ask_human", "asks you questions"]]],
];
const AGENT_PRESETS = {
  reader: { label: "Only reads", tools: ["read_file", "list_files", "search_files"] },
  builder: { label: "Reads and changes", tools: ["read_file", "list_files", "search_files", "edit_file", "write_file", "run_command"] },
};
let agentDraft;

function openAgentBuilder(preset, existing) {
  agentDraft = { name: "", description: "", prompt: "", tools: [...(AGENT_PRESETS[preset ?? "reader"].tools)], skills: [], subagents: [], effort: "", errors: [], saving: false };
  if (existing) {
    // Editing: the form starts from what the agent is. One with no list of tools
    // has every tool, so the form starts with every tool it offers ticked,
    // rather than with none, which would be a quiet change on save.
    const offered = AGENT_TOOL_GROUPS.flatMap(([, list]) => list.map(([tool]) => tool));
    agentDraft = {
      ...agentDraft,
      editing: existing.name,
      name: existing.name,
      description: existing.description ?? "",
      prompt: existing.prompt ?? "",
      tools: existing.tools === null ? offered : existing.tools.filter((tool) => offered.includes(tool)),
      skills: [...existing.skills],
      subagents: [...existing.subagents],
      effort: existing.effort ?? "",
      cut: Boolean(existing.promptCut),
    };
  }
  $("agent-modal-title").textContent = existing ? "Edit " + existing.name : "New agent";
  drawAgentBuilder();
  openModal("agent-modal");
}

function drawAgentBuilder() {
  const host = $("agent-body");
  host.replaceChildren();
  const draft = agentDraft;
  const skills = (contentData?.items ?? []).filter((item) => item.type === "skill").map((item) => item.name);
  const others = (agentData?.agents ?? []).filter((agent) => !agent.error).map((agent) => agent.name);
  const toggle = (list, name, on) => {
    const at = list.indexOf(name);
    if (on && at < 0) list.push(name);
    if (!on && at >= 0) list.splice(at, 1);
  };
  host.append(
    ...(draft.editing ? [el("p", { class: "muted", text: "Changing an agent makes it unreviewed again: lock it under Content afterwards. What this form does not show (provider, model) stays as it is." })] : []),
    ...(draft.editing ? [] : [field("agent-name", "Name", draft.name, (value) => { draft.name = value; }, "e.g. test-writer")]),
    field("agent-description", "What it is for (one line)", draft.description, (value) => { draft.description = value; }, ""),
  );
  const prompt = el("textarea", { attrs: { id: "agent-prompt", rows: "6", placeholder: "Its job, its limits, and how it reports back.", ...(draft.cut ? { disabled: "disabled" } : {}) } });
  prompt.value = draft.prompt;
  prompt.addEventListener("input", () => { draft.prompt = prompt.value; });
  host.append(el("div", { class: "field" }, [el("label", { text: draft.cut ? "What it is told (too long to edit here)" : "What it is told", attrs: { for: "agent-prompt" } }), prompt]));

  host.append(el("p", { class: "muted", text: "What it may do. Nothing ticked means it only answers." }));
  host.append(el("div", { class: "chips" }, Object.entries(AGENT_PRESETS).map(([key, entry]) => button(entry.label, { class: "btn small", onClick: () => { draft.tools = [...entry.tools]; drawAgentBuilder(); } }))));
  for (const [group, tools] of AGENT_TOOL_GROUPS) {
    host.append(el("h5", { class: "card-h", text: group }));
    for (const [tool, words] of tools) {
      host.append(checkField("agent-tool-" + tool, words, draft.tools.includes(tool), (on) => toggle(draft.tools, tool, on)));
    }
  }
  if (skills.length > 0) {
    host.append(el("h5", { class: "card-h", text: "Skills it can open" }));
    for (const skill of skills) host.append(checkField("agent-skill-" + skill, skill, draft.skills.includes(skill), (on) => toggle(draft.skills, skill, on)));
  }
  if (others.length > 0) {
    host.append(el("h5", { class: "card-h", text: "Agents it can hand work to" }));
    for (const other of others) host.append(checkField("agent-sub-" + other, other, draft.subagents.includes(other), (on) => toggle(draft.subagents, other, on)));
  }
  host.append(selectField("agent-effort", "How hard it thinks", draft.effort, [["", "the provider's own"], ["low", "low"], ["medium", "medium"], ["high", "high"]], (value) => { draft.effort = value; }));
  if (draft.errors.length > 0) host.append(el("div", { class: "notice bad", attrs: { role: "alert" } }, draft.errors.map((message) => el("p", { text: message }))));
  $("agent-save").disabled = draft.saving;
}

async function saveAgent() {
  agentDraft.saving = true;
  agentDraft.errors = [];
  drawAgentBuilder();
  try {
    const { errors: _errors, saving: _saving, editing, cut, ...body } = agentDraft;
    if (cut) delete body.prompt;
    const made = editing
      ? await api("/api/agents/" + encodeURIComponent(editing), { method: "PUT", body: JSON.stringify(body) })
      : await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    closeModal("agent-modal");
    toast("Saved " + made.path + ". It is not reviewed yet: read it under Content, then lock it.");
    openAgentName = made.name;
    await loadProjectViews();
  } catch (error) {
    agentDraft.errors = error.details?.errors ?? [error.message];
  } finally {
    agentDraft.saving = false;
    drawAgentBuilder();
  }
}

// ---------------------------------------------------------------- workflows

function workflowsPanel() {
  const data = workflowData ?? { workflows: [] };
  const body = [];
  if (data.configured) {
    body.push(el("article", { class: "card" }, [
      el("h4", { class: "card-title", text: "The project's own workflow" }),
      el("p", { class: "card-sub", text: "Written in etnpilot.yaml. This is what a run follows when no other is chosen." }),
      flow(data.configured.steps),
    ]));
  }
  for (const workflow of data.workflows) body.push(workflowCard(workflow));
  if (body.length === 0) {
    body.push(el("p", { class: "empty", text: "No workflow yet: a run is one agent. A workflow says which agents work in which order, where you approve, and what is checked." }));
  }
  return panel("Workflows", {
    meta: button("New workflow", { class: "btn tonal", onClick: () => openWorkflowBuilder() }),
    body,
    open: true,
  });
}

function workflowCard(workflow) {
  const failed = (workflow.errors ?? []).length > 0;
  const card = el("article", { class: "card" }, [
    el("h4", { class: "card-title", text: workflow.name }),
    ...(workflow.description ? [el("p", { class: "card-sub", text: workflow.description })] : []),
    el("div", { class: "chips" }, present([lockPill(workflow.lock), originPill(workflow.origin), failed ? pill("has problems", "bad") : null])),
    flow(workflow.steps),
  ]);
  for (const message of workflow.errors ?? []) card.append(el("p", { class: "notice bad", text: message }));
  card.append(el("div", { class: "card-actions" }, [
    button("Remove", { class: "btn danger", onClick: () => removeNamed("workflow", workflow.name, workflow.path) }),
    button("Edit", { class: "btn", onClick: () => openWorkflowBuilder(undefined, workflow) }),
    button("Read the file", { class: "btn", onClick: () => openContentFile(workflow.path) }),
    ...(failed ? [] : [button("Start a run with it", { class: "btn tonal", onClick: () => startRunWith({ workflow: workflow.name }) })]),
  ]));
  return card;
}

function flow(steps) {
  const list = el("ol", { class: "flow" });
  for (const step of steps ?? []) {
    const type = step.type ?? "agent";
    let what = step.agent ?? "";
    if (type === "check") what = (step.command ?? []).join(" ");
    if (type === "gate") what = step.prompt ?? "you decide whether it goes on";
    if (type === "quorum") what = (step.agents ?? []).join(", ");
    list.append(el("li", { class: "flow-step type-" + type }, [
      el("span", { class: "flow-head" }, [
        el("span", { class: "flow-id", text: step.id }),
        el("span", { class: "flow-type", text: STEP_LABELS[type] ?? type }),
      ]),
      el("span", { class: "flow-what", text: what }),
      ...((step.needs ?? []).length > 0 ? [el("span", { class: "flow-needs", text: "after " + step.needs.join(", ") })] : []),
    ]));
  }
  return list;
}

// ------------------------------------------------------------ the builder

const BUILDER_PRESETS = {
  "plan-build-check": {
    name: "plan-build-check",
    description: "Plan, wait for your approval, build, then check.",
    steps: [
      { id: "plan", type: "agent", agent: "" },
      { id: "approve-plan", type: "gate", needs: ["plan"] },
      { id: "build", type: "agent", agent: "", needs: ["approve-plan"], expect: "tool-use" },
      { id: "check", type: "check", command: "npm test", needs: ["build"] },
    ],
  },
  "build-review": {
    name: "build-review",
    description: "Build, then have a reviewer read it.",
    steps: [
      { id: "build", type: "agent", agent: "", expect: "tool-use" },
      { id: "review", type: "agent", agent: "", needs: ["build"] },
    ],
  },
  empty: { name: "", description: "", steps: [{ id: "step-1", type: "agent", agent: "" }] },
};

let builder;

function openWorkflowBuilder(preset, existing) {
  const names = (workflowData?.agents ?? []);
  const base = existing
    ? { name: existing.name, description: existing.description ?? "", steps: JSON.parse(JSON.stringify(existing.steps)) }
    : JSON.parse(JSON.stringify(BUILDER_PRESETS[preset ?? "empty"]));
  $("workflow-modal-title").textContent = existing ? "Edit " + existing.name : "New workflow";
  // Agent steps start on the first agent that exists, so a preset is runnable as soon as it is saved.
  for (const step of base.steps) if (step.type === "agent" && !step.agent) step.agent = names[0] ?? "";
  builder = { workflow: base, errors: [], saving: false, editing: existing?.name };
  drawBuilder();
  openModal("workflow-modal");
}

function drawBuilder() {
  const host = $("workflow-body");
  host.replaceChildren();
  const w = builder.workflow;
  const agents = workflowData?.agents ?? [];

  host.append(
    ...(builder.editing ? [el("p", { class: "muted", text: "Changing a workflow makes it unreviewed again: lock it under Content afterwards." })] : [el("p", { class: "muted", text: "Start from a pattern, or build your own:" })]),
    el("div", { class: "chips" }, builder.editing ? [] : Object.keys(BUILDER_PRESETS).filter((key) => key !== "empty").map((key) => {
      const chip = button(key, { class: "btn small", onClick: () => openWorkflowBuilder(key) });
      return chip;
    })),
    ...(builder.editing ? [] : [field("workflow-name", "Name", w.name, (value) => { w.name = value; }, "e.g. plan-build-check")]),
    field("workflow-description", "What it is for (optional)", w.description ?? "", (value) => { w.description = value; }, ""),
  );

  w.steps.forEach((step, index) => {
    const card = el("article", { class: "builder-step" });
    card.append(el("div", { class: "builder-head" }, [
      el("span", { class: "builder-num", text: String(index + 1) }),
      field("step-id-" + index, "Step name", step.id, (value) => { step.id = value; }, ""),
      button("Remove", { class: "btn link", onClick: () => { w.steps.splice(index, 1); drawBuilder(); } }),
    ]));
    card.append(selectField("step-type-" + index, "What it does", step.type, [["agent", "An agent works"], ["check", "A command is checked"], ["gate", "You approve before it goes on"], ["quorum", "Several agents compare"]], (value) => {
      step.type = value;
      if (value === "agent" && !step.agent) step.agent = agents[0] ?? "";
      drawBuilder();
    }));
    if (step.type === "agent") {
      card.append(selectField("step-agent-" + index, "Agent", step.agent ?? "", agents.map((name) => [name, name]), (value) => { step.agent = value; }));
      card.append(checkField("step-expect-" + index, "It must change something (a step that only describes the work fails)", step.expect === "tool-use", (on) => { step.expect = on ? "tool-use" : undefined; }));
    }
    if (step.type === "check") card.append(field("step-command-" + index, "Command", Array.isArray(step.command) ? step.command.join(" ") : (step.command ?? ""), (value) => { step.command = value; }, "npm test"));
    if (step.type === "gate") card.append(field("step-prompt-" + index, "The question you are asked", step.prompt ?? "", (value) => { step.prompt = value; }, "Continue past this step?"));
    if (step.type === "quorum") {
      card.append(el("p", { class: "muted", text: "Agents that compare (choose at least two):" }));
      for (const name of agents) {
        card.append(checkField("step-q-" + index + "-" + name, name, (step.agents ?? []).includes(name), (on) => {
          const set = new Set(step.agents ?? []);
          if (on) set.add(name); else set.delete(name);
          step.agents = [...set];
        }));
      }
    }
    if (index > 0) {
      card.append(el("p", { class: "muted", text: "Starts after:" }));
      for (const earlier of w.steps.slice(0, index)) {
        card.append(checkField("step-needs-" + index + "-" + earlier.id, earlier.id, (step.needs ?? []).includes(earlier.id), (on) => {
          const set = new Set(step.needs ?? []);
          if (on) set.add(earlier.id); else set.delete(earlier.id);
          step.needs = [...set];
        }));
      }
    }
    host.append(card);
  });

  host.append(button("Add a step", { class: "btn tonal", onClick: () => {
    const previous = w.steps.at(-1);
    w.steps.push({ id: "step-" + (w.steps.length + 1), type: "agent", agent: agents[0] ?? "", needs: previous ? [previous.id] : [] });
    drawBuilder();
  } }));

  if (builder.errors.length > 0) {
    const box = el("div", { class: "notice bad", attrs: { role: "alert" } }, builder.errors.map((message) => el("p", { text: message })));
    host.append(box);
  }
  $("workflow-save").disabled = builder.saving;
}

function field(id, label, value, onInput, placeholder) {
  const input = el("input", { attrs: { id, value: value ?? "", autocomplete: "off", placeholder: placeholder ?? "" } });
  input.addEventListener("input", () => onInput(input.value));
  return el("div", { class: "field" }, [el("label", { text: label, attrs: { for: id } }), input]);
}

function selectField(id, label, value, options, onChange) {
  const select = el("select", { attrs: { id } }, options.map(([optionValue, text]) => el("option", { text, attrs: { value: optionValue, ...(optionValue === value ? { selected: "selected" } : {}) } })));
  select.addEventListener("change", () => onChange(select.value));
  return el("div", { class: "field" }, [el("label", { text: label, attrs: { for: id } }), select]);
}

function checkField(id, label, checked, onChange) {
  const box = el("input", { attrs: { type: "checkbox", id, ...(checked ? { checked: "checked" } : {}) } });
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { class: "check" }, [box, el("span", { text: label })]);
}

async function saveWorkflow() {
  builder.saving = true;
  builder.errors = [];
  drawBuilder();
  try {
    const made = builder.editing
      ? await api("/api/workflows/" + encodeURIComponent(builder.editing), { method: "PUT", body: JSON.stringify(builder.workflow) })
      : await api("/api/workflows", { method: "POST", body: JSON.stringify(builder.workflow) });
    closeModal("workflow-modal");
    toast("Saved " + made.path + ". It is not reviewed yet: read it under Content, then lock it.");
    await loadProjectViews();
  } catch (error) {
    builder.errors = error.details?.errors ?? [error.message];
  } finally {
    builder.saving = false;
    if (builder) drawBuilder();
  }
}

// ----------------------------------------------------------------- Content

function renderContent() {
  const host = $("view-content");
  host.replaceChildren();
  if (projectError && !contentData) host.append(el("p", { class: "notice bad", text: projectError }));
  if (!contentData) {
    host.append(el("p", { class: "empty", text: "Reading the project content…" }));
    return;
  }
  const data = contentData;
  if (data.problem) {
    host.append(el("div", { class: "banner" }, [icon("M12 3l10 18H2z M12 10v4 M12 17.5v.01"), el("div", { class: "banner-text" }, [el("p", { class: "banner-title", text: "This content cannot be read safely" }), el("p", { text: data.problem })])]));
    return;
  }
  host.append(lockBanner(data));
  const filters = [["review", "Needs review"], ["all", "Everything"]];
  host.append(el("div", { class: "chips filters" }, filters.map(([id, label]) => {
    const chip = button(label, { class: contentFilter === id ? "btn tonal" : "btn", onClick: () => { contentFilter = id; render(); } });
    chip.setAttribute("aria-pressed", String(contentFilter === id));
    return chip;
  })));
  const shown = data.items.filter((item) => contentFilter === "all" || item.status !== "locked");
  if (shown.length === 0 && (data.removed ?? []).length === 0) {
    host.append(el("p", { class: "empty", text: contentFilter === "review" ? "Nothing waits for review: everything is locked as you left it." : "No project content." }));
  }
  for (const type of Object.keys(TYPE_LABELS)) {
    const rows = shown.filter((item) => item.type === type);
    if (rows.length === 0) continue;
    host.append(panel(TYPE_LABELS[type], { meta: String(rows.length), body: rows.map(contentRow), open: true }));
  }
  if ((data.removed ?? []).length > 0) {
    host.append(panel("Removed since the lock", { meta: String(data.removed.length), body: data.removed.map((entry) => el("p", { class: "mono", text: entry.path })), open: true }));
  }
}

function lockBanner(data) {
  if (data.mode === "off") {
    return el("div", { class: "banner info" }, [icon("M12 3a9 9 0 100 18 9 9 0 000-18z M12 11v5 M12 7.5v.01"), el("div", { class: "banner-text" }, [
      el("p", { class: "banner-title", text: "Content is not checked" }),
      el("p", { text: "content.provenance.mode is off, so a run uses whatever is in .etnpilot/ without a lock." }),
    ])]);
  }
  const waiting = data.unreviewed ?? 0;
  const text = el("div", { class: "banner-text" }, [
    el("p", { class: "banner-title", text: waiting === 0 ? "Everything is locked" : waiting + (waiting === 1 ? " item is not locked" : " items are not locked") }),
    el("p", { text: waiting === 0
      ? "A run uses exactly the content you locked."
      : "A run refuses content that has no lock or no longer matches it. Read what is new or changed, then lock it: that is you taking responsibility for it." }),
  ]);
  const banner = el("div", { class: waiting === 0 ? "banner info" : "banner" }, [icon(waiting === 0 ? "M5 12l4 4L19 6" : "M12 3l10 18H2z M12 10v4 M12 17.5v.01"), text]);
  if (data.canLock) {
    banner.append(el("div", { class: "banner-actions" }, [button("Lock what I reviewed", { class: "btn tonal", onClick: openLockDialog })]));
  }
  return banner;
}

function contentRow(item) {
  const row = el("button", { class: "content-row state", attrs: { type: "button" } }, [
    el("span", { class: "card-main" }, [
      el("span", { class: "card-title", text: item.name }),
      el("span", { class: "card-sub", text: item.summary || item.path }),
      el("span", { class: "chips" }, present([lockPill(item.status), originPill(item.origin)])),
    ]),
    el("span", { class: "card-chev", text: "›" }),
  ]);
  row.addEventListener("click", () => openContentFile(item.path));
  return row;
}

async function openContentFile(path) {
  $("file-title").textContent = path;
  $("file-status").replaceChildren();
  $("file-body").textContent = "Reading…";
  openModal("file-modal");
  try {
    const found = await api("/api/content/file?path=" + encodeURIComponent(path));
    const known = (contentData?.items ?? []).find((item) => item.path === path);
    $("file-status").append(...present([lockPill(known?.status), originPill(found.origin), pill(found.digest.slice(0, 12))]));
    $("file-body").textContent = found.content;
  } catch (error) {
    $("file-body").textContent = error.message;
  }
}

function openLockDialog() {
  const data = contentData;
  const fresh = data.items.filter((item) => item.status === "new");
  const changed = data.items.filter((item) => item.status === "changed");
  const lines = [];
  if (fresh.length > 0) lines.push(fresh.length + " new: " + fresh.map((item) => item.type + " " + item.name).slice(0, 8).join(", ") + (fresh.length > 8 ? " and more" : ""));
  if (changed.length > 0) lines.push(changed.length + " changed: " + changed.map((item) => item.type + " " + item.name).slice(0, 8).join(", "));
  if ((data.removed ?? []).length > 0) lines.push(data.removed.length + " removed: " + data.removed.map((item) => item.type + " " + item.name).slice(0, 8).join(", "));
  $("lock-summary").replaceChildren(...lines.map((line) => el("li", { text: line })));
  openModal("lock-modal");
}

async function confirmLock() {
  const submit = $("lock-confirm");
  submit.disabled = true;
  try {
    contentData = await api("/api/content/lock", { method: "POST", body: JSON.stringify({ manifestDigest: contentData.manifestDigest }) });
    closeModal("lock-modal");
    toast("Locked. A run now uses exactly this content. Commit .etnpilot/ so a worktree has it too.");
    await loadProjectViews();
  } catch (error) {
    closeModal("lock-modal");
    // The usual reason is that the files moved while the person was reading.
    toast(error.message, "bad");
    await loadProjectViews();
  } finally {
    submit.disabled = false;
  }
}

function startRunWith({ agent, workflow }) {
  openModal("run-modal");
  void prepareRunModal().then(() => {
    if (agent) $("run-agent").value = agent;
    if (workflow && $("run-workflow")) $("run-workflow").value = workflow;
    describeRunChoice();
  });
}
`;
