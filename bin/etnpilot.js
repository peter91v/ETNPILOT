#!/usr/bin/env node

import { parseArgs } from "node:util";
import { CLI_OPTIONS, runCli } from "../src/cli/commands.js";

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: CLI_OPTIONS });
  process.exitCode = await runCli(positionals, values);
} catch (error) {
  // Operators see one actionable line; ETNPILOT_DEBUG keeps the stack for us.
  console.error(`etnpilot: ${error?.message ?? error}`);
  if (error?.cause?.message) console.error(`  caused by: ${error.cause.message}`);
  if (process.env.ETNPILOT_DEBUG) console.error(error);
  process.exitCode = 1;
}
