import { isCodeGraphUnavailable } from "../../src/codegraph/codegraph.js";

// The upstream engine ships its compiled library in per-platform bundles and
// publishes none for some platforms — Android, for one. Tests that need the
// real engine are skipped there, naming the platform as the reason.
//
// Only that one failure is a reason to skip. A package that is missing
// outright, or any other import error, stays red: that is a real fault and
// hiding it would be exactly the evasion this project forbids elsewhere.
const engine = await import("@colbymchenry/codegraph").then(
  () => ({ available: true }),
  (error) => ({ available: false, error }),
);

export const needsCodeGraphEngine = engine.available || !isCodeGraphUnavailable(engine.error)
  ? {}
  : { skip: `no CodeGraph bundle is published for ${process.platform}-${process.arch}` };
