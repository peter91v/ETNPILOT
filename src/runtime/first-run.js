import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeProject, PROJECT_TEMPLATES } from "../config/init.js";
import { git } from "../git/command.js";

// What to show somebody who opened a surface in a directory with no project in
// it. Until now every surface answered that with the ENOENT of the file it
// tried to read, which names a path and nothing a person can do about it.
//
// One sentence per template, and the settings each one changes are read from
// the template itself rather than written out here — a description that is
// maintained separately is a description that ends up wrong.
const TEMPLATE_NOTES = Object.freeze({
  default: "Everything on: the code graph, telemetry, and pinned project content.",
  minimal: "The smallest thing that runs. Good on a phone, or for trying it out.",
  regulated: "Signed receipts, a sandbox, and a license allow-list.",
});

export function projectTemplates() {
  return Object.entries(PROJECT_TEMPLATES).map(([id, overrides]) => ({
    id,
    about: TEMPLATE_NOTES[id] ?? "",
    // The settings this template changes from the documented default, as it
    // will actually write them.
    changes: Object.entries(overrides).map(([path, value]) => ({ path, value })),
  }));
}

// Whether there is a project here, and what creating one would involve. It
// never creates anything: a surface asks this first, and a person decides.
export async function describeProject({ root = process.cwd() } = {}) {
  const projectRoot = resolve(root);
  const configFile = join(projectRoot, ".etnpilot", "etnpilot.yaml");
  const exists = await access(configFile).then(() => true, () => false);
  const directory = await stat(projectRoot).then((entry) => entry.isDirectory(), () => false);
  // A run needs a checkout: it works in a worktree and rehearses a merge. Not
  // having one is not a reason to refuse the project, but it is the next thing
  // a person will hit, so it is said here rather than at the first run.
  const checkout = directory
    ? await git(["rev-parse", "--show-toplevel"], { cwd: projectRoot }).then(
      (result) => ({ inside: true, top: result.stdout.trim() }),
      () => ({ inside: false }),
    )
    : { inside: false };
  return {
    root: projectRoot,
    configFile,
    exists,
    directory,
    checkout,
    templates: projectTemplates(),
  };
}

// Creates the project a surface offered. The template name comes from a person
// choosing one of the rows above, and is checked against the same list, so a
// name from anywhere else cannot reach 'initializeProject'.
export async function createProject({ root = process.cwd(), template = "default" } = {}) {
  if (!Object.hasOwn(PROJECT_TEMPLATES, template)) {
    throw new TypeError(`Unknown project template '${template}'. Available: ${Object.keys(PROJECT_TEMPLATES).join(", ")}.`);
  }
  const created = await initializeProject(resolve(root), { template });
  return { ...created, configFile: join(created.configDir, "etnpilot.yaml") };
}
