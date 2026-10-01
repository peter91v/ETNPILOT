// @ts-check
import { workspaceFile, digestBytes } from "./workspace-files.js";

export async function undoFileEffects(root, effects) {
  const reverted = [];
  const skipped = [];
  for (const effect of effects) {
    let file;
    try {
      file = await workspaceFile(root, effect.path, { maxBytes: 256 * 1024, missing: true });
      const current = file.bytes === undefined ? null : digestBytes(file.bytes);
      if (current !== effect.after) { skipped.push({ path: effect.path, reason: current === null ? "it was deleted since" : "it was changed since the turn" }); continue; }
      if (effect.before === null) await file.remove();
      else {
        if (typeof effect.beforeContent !== "string" || digestBytes(Buffer.from(effect.beforeContent)) !== effect.before) throw new Error("Invalid file journal preimage.");
        await file.write(Buffer.from(effect.beforeContent));
      }
      reverted.push(effect.path);
    } catch (error) { skipped.push({ path: effect.path, reason: error.message }); }
    finally { await file?.close(); }
  }
  return { reverted, skipped };
}
