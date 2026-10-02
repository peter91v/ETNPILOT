import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runAuthorCommand } from "../src/cli/author.js";
import { applyDraft, draftImprovement, draftNew, lineDiff, renderDiff } from "../src/forge/author.js";
import { chooseProvider } from "../src/forge/forge.js";
import { createProject } from "../src/runtime/first-run.js";
import { renderProjectConfig } from "../src/config/init.js";
import YAML from "yaml";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etn-author-"));
  await writeFile(join(root, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  await createProject({ root, template: "minimal", forge: false });
  return root;
}

const reply = (object) => async () => ({ text: JSON.stringify(object), usage: {} });
const agentAnswer = { agents: [{ name: "Test Writer", description: "writes tests", tools: ["read_file", "write_file", "network"], skills: [], prompt: "Write tests with npm test." }], skills: [{ name: "extra", body: "not wanted" }], instructions: [] };

test("a new agent is drafted with one thing only, checked, and written beside its prompt", async () => {
  const root = await project();
  const draft = await draftNew("agent", "an agent that writes tests", { root, config: {}, runModel: reply(agentAnswer) });
  assert.equal(draft.plan.agents.length, 1);
  assert.equal(draft.plan.skills.length, 0, "only the asked kind is kept");
  assert.deepEqual(draft.plan.agents[0].tools, ["read_file", "write_file"], "a tool it may not have is dropped");
  assert.equal(draft.plan.agents[0].name, "test-writer");
  const result = await applyDraft(draft, { root });
  assert.equal(result.agents.length, 1);
  assert.match(await readFile(join(root, ".etnpilot", "prompts", "test-writer.md"), "utf8"), /npm test/);
  const again = await applyDraft(draft, { root });
  assert.equal(again.skipped.length, 1, "an existing agent is never overwritten");
});

test("an improvement shows what changed and replaces only the file it was drafted from", async () => {
  const root = await project();
  await mkdir(join(root, ".etnpilot", "prompts"), { recursive: true });
  const path = join(root, ".etnpilot", "prompts", "orchestrator.md");
  await writeFile(path, "Line one.\nLine two.\nLine three.\n");
  const draft = await draftImprovement("prompt", "orchestrator", "stricter", {
    root, config: {}, runModel: reply({ text: "Line one.\nLine two, strictly.\nLine three.", summary: "Stricter line two." }),
  });
  assert.deepEqual(draft.diff.filter((line) => line.op !== " ").map((line) => line.op + line.text), ["-Line two.", "+Line two, strictly."]);
  assert.match(renderDiff(draft.diff).join("\n"), /^- Line two\.$/m);
  await writeFile(path, "Someone else changed it.\n");
  await assert.rejects(applyDraft(draft, { root }), /changed while the draft was being made/);
  await writeFile(path, draft.before);
  await applyDraft(draft, { root });
  assert.equal(await readFile(path, "utf8"), "Line one.\nLine two, strictly.\nLine three.\n");
  await assert.rejects(draftImprovement("prompt", "../../x", "y", { root, config: {}, runModel: reply({}) }), /not a name|There is no/);
});

test("a skill improvement keeps its front matter", async () => {
  const root = await project();
  const path = join(root, ".etnpilot", "skills", "release", "SKILL.md");
  await mkdir(join(root, ".etnpilot", "skills", "release"), { recursive: true });
  await writeFile(path, "---\nname: release\ndescription: \"cut a release\"\n---\nStep 1.\n");
  const draft = await draftImprovement("skill", "release", "add a step", { root, config: {}, runModel: reply({ text: "Step 1.\nStep 2.", summary: "Added step 2." }) });
  await applyDraft(draft, { root });
  assert.equal(await readFile(path, "utf8"), "---\nname: release\ndescription: \"cut a release\"\n---\nStep 1.\nStep 2.\n");
});

test("the terminal asks before it writes, and --dry-run and --yes behave", async () => {
  const root = await project();
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => { text += chunk; });
  const common = { stdout: out, runModel: reply(agentAnswer), prompter: { ask: async () => "", confirm: async () => false, secret: async () => "" } };
  assert.equal(await runAuthorCommand("agent", ["writes", "tests"], { root, "dry-run": true }, common), 0);
  assert.match(text, /Dry run: nothing was written/);
  assert.equal(await runAuthorCommand("agent", ["writes", "tests"], { root }, common), 0);
  assert.match(text, /Nothing was written\./);
  await assert.rejects(readFile(join(root, ".etnpilot", "agents", "test-writer.yaml"), "utf8"), /ENOENT/);
  assert.equal(await runAuthorCommand("agent", ["writes", "tests"], { root, yes: true }, common), 0);
  assert.match(text, /Wrote \.etnpilot\/agents\/test-writer\.yaml/);
  assert.match(text, /content lock/);
});

test("forge.provider and forge.model choose who drafts, and the model only goes to that provider", async () => {
  const template = YAML.parse(renderProjectConfig());
  const env = { OPENAI_API_KEY: ["sk", "test", "openai", "key", "12345"].join("-"), ANTHROPIC_API_KEY: ["sk", "ant", "test", "anthropic", "key", "12345"].join("-") };
  const root = await mkdtemp(join(tmpdir(), "etn-choose-"));
  const base = { ...template, defaultProvider: "openai", forge: undefined };
  const chosen = await chooseProvider({ ...base, forge: { provider: "anthropic", model: "claude-opus-5-5" } }, root, env);
  assert.deepEqual([chosen.name, chosen.config.model], ["anthropic", "claude-opus-5-5"]);
  const byDefault = await chooseProvider(base, root, env);
  assert.equal(byDefault.name, "anthropic", "an Anthropic provider is preferred without a setting");
  const onlyOpenAi = await chooseProvider({ ...base, forge: { provider: "anthropic", model: "claude-opus-5-5" } }, root, { OPENAI_API_KEY: env.OPENAI_API_KEY });
  assert.deepEqual([onlyOpenAi.name, onlyOpenAi.config.model, onlyOpenAi.preferred], ["openai", template.providers.openai.model, "anthropic"], "the Claude model name never goes to OpenAI");
  const named = await chooseProvider({ ...base, forge: { provider: "openai", model: "my-model" } }, root, env);
  assert.deepEqual([named.name, named.config.model], ["openai", "my-model"]);
  assert.deepEqual([template.forge.provider, template.forge.model], ["anthropic", "claude-opus-5-5"], "new projects start with the stronger setting");
});

test("the line diff marks removed and added lines", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nc").map((line) => line.op), [" ", "-", "+"]);
});

test("a prompt can be written on its own, never over one that exists, and existing ones are listed to pick from", async () => {
  const root = await project();
  const { listItems } = await import("../src/forge/author.js");
  const draft = await draftNew("prompt", "a strict code reviewer prompt", { root, config: {}, runModel: reply({ name: "Strict Reviewer", body: "Review the diff. Be strict." }) });
  assert.equal(draft.plan.prompts[0].name, "strict-reviewer");
  const result = await applyDraft(draft, { root });
  assert.equal(result.prompts.length, 1);
  assert.equal(await readFile(join(root, ".etnpilot", "prompts", "strict-reviewer.md"), "utf8"), "Review the diff. Be strict.\n");
  assert.equal((await applyDraft(draft, { root })).skipped.length, 1);
  assert.deepEqual(await listItems("prompt", join(root, ".etnpilot")), ["orchestrator", "strict-reviewer"]);
  assert.deepEqual(await listItems("skill", join(root, ".etnpilot")), []);
  await assert.rejects(draftNew("prompt", "x", { root, config: {}, runModel: reply({ name: "", body: "" }) }), /no usable prompt/);
});
