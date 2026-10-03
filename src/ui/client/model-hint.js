// Which provider and model a choice leads to, so a field that says "the agent's
// own" can say what that is. Read from what the project configures: the
// agent's manifest, else the project's default provider, and a model typed by
// the person above all. A model name belongs to one vendor, so an agent's own
// model is only claimed while its own provider answers.

function effectiveChoice({ agent: agentName, provider: providerName, model: typed } = {}) {
  const known = agents ?? {};
  const name = agentName || known.defaultAgent || "orchestrator";
  const agent = (known.agents ?? []).find((entry) => entry.name === name && !entry.error);
  const provider = providerName || agent?.provider || known.defaultProvider;
  if (!provider) return undefined;
  const own = !providerName && agent?.provider === provider && agent?.model;
  const configured = known.providerInfo?.[provider]?.model;
  const model = typed || own || configured;
  return { provider, model, source: typed ? "typed" : own ? "agent" : configured ? "provider" : "none" };
}

// "openai · gpt-5", or just the provider when no model is known.
function describeChoice(choice) {
  if (!choice) return "";
  return choice.provider + (choice.model ? " · " + choice.model : "");
}

// The providers and agents the hints are drawn from, read once if no other view
// has read them yet (the chat and the run dialog read them as they open).
async function ensureAgentInfo() {
  if (agents?.providerInfo) return;
  try {
    agents = await api("/api/agents");
  } catch {
    // The hints just stay general.
  }
}

// The providers the project configures. A function of its own because several
// builders name the list of agents `agents` too, and that would hide this one.
function providerNames() {
  return agents?.providers ?? [];
}
