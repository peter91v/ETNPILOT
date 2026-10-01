// @ts-check
import { resolve } from "node:path";
import { DEFAULT_KEEP, DEFAULT_OLDER_THAN_DAYS, applyGc, planGc } from "../../runtime/gc.js";

export const gcCommands = [
  {
    match: ({ command }) => command === "gc",
    async run({ values }) {
      const olderThanDays = values["older-than"] === undefined ? DEFAULT_OLDER_THAN_DAYS : parseDays(values["older-than"]);
      const keep = values.keep === undefined ? DEFAULT_KEEP : Number(values.keep);
      const plan = await planGc({ root: resolve(values.root), olderThanDays, keep });
      const megabytes = (plan.bytes / 1_048_576).toFixed(1);
      if (values.json) console.log(JSON.stringify({ ...plan, candidates: plan.candidates.map(({ kind, name, bytes }) => ({ kind, name, bytes })) }, null, 2));
      else {
        console.log(`Older than ${olderThanDays} days, beyond the newest ${keep}, and sealed: ${plan.candidates.length} file(s), ${megabytes} MiB.`);
        console.log(`Kept: ${plan.kept.newest} newest, ${plan.kept.young} recent, ${plan.kept.unsealed} not sealed.`);
        for (const file of plan.candidates.slice(0, 20)) console.log(`  ${file.kind.padEnd(9)}${file.name}`);
        if (plan.candidates.length > 20) console.log(`  … and ${plan.candidates.length - 20} more`);
      }
      if (!values.apply) {
        if (plan.candidates.length > 0 && !values.json) console.log("\nNothing was deleted. Receipts are the record of what ran; add --apply to delete these.");
        return;
      }
      const result = await applyGc(plan);
      console.log(`Deleted ${result.removed.length} file(s).${result.failed.length > 0 ? ` ${result.failed.length} could not be deleted.` : ""}`);
      return result.failed.length > 0 ? 1 : 0;
    },
  },
];

function parseDays(text) {
  const days = Number(String(text).replace(/d$/, ""));
  if (!Number.isFinite(days) || days < 0) throw new Error("--older-than takes a number of days, such as 30 or 30d.");
  return days;
}
