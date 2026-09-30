import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { verifyProjectContent } from "../content/provenance.js";
import { summarizeTelemetryFile } from "../observability/telemetry.js";
import { PolicyEngine } from "../policy/engine.js";
import { checkDependencyPolicy } from "../supply/dependencies.js";
import { readProjectPackages } from "../supply/ecosystems.js";
import { scanForSecrets } from "../supply/secret-scan.js";
import { diagnose } from "./diagnose.js";

// The checks that until now existed only as CLI subcommands. One registry, so
// the terminal interface and the page run the same code and report the same
// result — a second implementation per surface is a second answer, and two
// answers to 'is this project sound' is worse than none.
//
// Every check answers the same three things: did it run at all, is it ok, and
// what exactly did it find. A check that cannot run says so; it never reports
// 'ok' for a question it could not ask.

const CHECKS = Object.freeze([
  {
    id: "doctor",
    title: "doctor",
    about: "Whether a run could start here, and against which provider.",
    async run({ root }) {
      const report = await diagnose(root);
      return {
        ok: report.ready === true,
        summary: report.ready
          ? `ready${report.routing?.usable ? ` · ${report.routing.usable}` : ""}`
          : "not ready",
        findings: report.hints.map((text) => ({ text, tone: "warn" })),
        detail: report,
      };
    },
  },
  {
    id: "policy",
    title: "policy check",
    about: "Every configured provider, against policy.providers.",
    async run({ root, config }) {
      if (!config?.policy) return { ok: undefined, summary: "no policy section", findings: [], detail: {} };
      const policy = new PolicyEngine(config.policy);
      const rows = Object.keys(config.providers ?? {}).map((name) => ({
        name,
        ...policy.evaluateProvider(name),
      }));
      const denied = rows.filter((row) => row.allowed === false);
      return {
        // A project may deny a provider on purpose, so a denial is reported,
        // not failed: what matters is that the list is the one in effect.
        ok: rows.length > 0,
        summary: rows.length === 0
          ? "no providers configured"
          : `${rows.length - denied.length} of ${rows.length} allowed`,
        findings: rows.map((row) => ({
          label: row.name,
          text: row.allowed === false
            ? `denied by ${row.rule ? `rule '${row.rule}'` : "the section default"}`
            : `allowed by ${row.rule ? `rule '${row.rule}'` : "the section default"}`,
          tone: row.allowed === false ? "bad" : "ok",
        })),
        detail: { providers: rows },
      };
    },
  },
  {
    id: "content",
    title: "content verify",
    about: "The prompts and manifests, against the committed lock.",
    async run({ root, config }) {
      // A mismatch is reported by a throw, and it is a finding rather than a
      // broken check: the project is exactly as sound as this says.
      let report;
      try {
        report = await verifyProjectContent(root, config ?? {});
      } catch (error) {
        return {
          ok: false,
          summary: error.code ?? "does not match the lock",
          findings: [{ label: error.code ?? "mismatch", text: error.message, tone: "bad" }],
          detail: { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ?? {}) },
        };
      }
      if (report.mode === "off") {
        return {
          ok: undefined,
          summary: "provenance is off",
          findings: [{ text: "content.provenance.mode is 'off', so nothing is pinned or checked.", tone: "warn" }],
          detail: report,
        };
      }
      return {
        ok: report.verified === true,
        summary: `${report.entries?.length ?? 0} files match the lock`,
        findings: [],
        detail: report,
      };
    },
  },
  {
    id: "deps",
    title: "deps check",
    about: "The declared dependencies, against supplyChain.",
    async run({ root, config }) {
      const supplyChain = config?.supplyChain ?? {};
      const inventory = await readProjectPackages(root, supplyChain);
      const report = checkDependencyPolicy(inventory.packages, supplyChain);
      return {
        ok: report.ok === true,
        // 'ecosystems' is a list of records, not of names: joining it gives
        // '[object Object]', which a run of this check showed on the first try.
        summary: `${inventory.packages.length} packages · `
          + (inventory.ecosystems.map((entry) => entry.id).join(", ") || "no ecosystem found"),
        findings: (report.violations ?? []).map((violation) => ({
          label: violation.reason,
          text: `${violation.package}@${violation.version}`
            + `${violation.license ? ` — ${violation.license}` : ""}`
            + `${violation.ecosystem ? ` (${violation.ecosystem})` : ""}`,
          tone: "bad",
        })),
        detail: { ecosystems: inventory.ecosystems, ...report },
      };
    },
  },
  {
    id: "secrets",
    title: "scan secrets",
    about: "The working tree, for credentials that must not be committed.",
    async run({ root, config }) {
      // It scans what git tracks, so outside a checkout there is nothing to
      // scan — which is not 'nothing found'. Saying which of the two it is
      // matters on a machine where the project was copied rather than cloned.
      let report;
      try {
        report = await scanForSecrets(root, { allow: config?.supplyChain?.secretScan?.allow ?? [] });
      } catch (error) {
        if (!/not a git repository/i.test(error.message)) throw error;
        return {
          ok: undefined,
          summary: "not a git checkout",
          findings: [{ text: "It scans the files git tracks, and this directory is not a checkout.", tone: "warn" }],
          detail: { error: error.message },
        };
      }
      return {
        ok: report.ok === true,
        summary: report.ok
          ? `${report.scanned} files, nothing found`
          : `${report.findings.length} to look at, in ${report.scanned} files`,
        // The value itself is never echoed here either; the preview and the
        // fingerprint are what the scanner chose to make quotable.
        findings: (report.findings ?? []).map((finding) => ({
          label: finding.rule,
          text: `${finding.path}:${finding.line} ${finding.preview}`,
          tone: "bad",
        })),
        detail: report,
      };
    },
  },
  {
    id: "telemetry",
    title: "telemetry summary",
    about: "What the recorded runs cost, from the telemetry file.",
    async run({ root, config }) {
      const path = resolve(root, config?.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
      const summary = await summarizeTelemetryFile(path);
      const spans = summary.spans ?? 0;
      const cost = summary.estimatedCost === undefined
        ? "not priced"
        : `${summary.currency ? `${summary.currency} ` : ""}${summary.estimatedCost.toFixed(4)}`;
      return {
        // No telemetry yet is not a failure — it is a project that has not run.
        ok: undefined,
        summary: spans === 0
          ? "nothing recorded yet"
          : `${summary.invocations} provider calls · ${cost}`,
        // Which rate is missing, named: the one thing this summary knows that
        // a person cannot work out from the number.
        findings: (summary.unpricedModels ?? []).map((entry) => ({
          label: entry.model,
          text: `${entry.calls} ${entry.calls === 1 ? "call" : "calls"} without a rate`
            + (entry.pricedSince ? " — a rate exists now, but it came after these calls" : ""),
          tone: "warn",
        })),
        detail: summary,
      };
    },
  },
]);

export function listChecks() {
  return CHECKS.map(({ id, title, about }) => ({ id, title, about }));
}

export function knownCheck(id) {
  return CHECKS.some((check) => check.id === id);
}

// Runs one check and returns what it found, never throwing: a check that blew
// up is itself a result — it says which one and why, and the other checks stay
// usable. 'ok' is undefined where the check has no pass/fail to report.
export async function runProjectCheck(id, { root, config, now = Date.now } = {}) {
  const check = CHECKS.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`Unknown check '${id}'. Known: ${CHECKS.map((one) => one.id).join(", ")}.`);
  const startedAt = now();
  // ISO, like every other timestamp a surface reads here, so 'since' and a
  // JSON reader see the same thing.
  const ranAt = new Date(startedAt).toISOString();
  const resolved = config === undefined
    ? await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(() => undefined)
    : config;
  try {
    const result = await check.run({ root, config: resolved });
    return { id, title: check.title, ranAt, durationMs: now() - startedAt, ...result };
  } catch (error) {
    return {
      id,
      title: check.title,
      ranAt,
      durationMs: now() - startedAt,
      ok: false,
      summary: "could not run",
      findings: [{ label: "error", text: error.message, tone: "bad" }],
      detail: { error: error.message },
    };
  }
}
