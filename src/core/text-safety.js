// Approval prompts render text an agent controls. Control characters could
// hide or fake parts of a command in a terminal, so they are escaped before
// a human ever sees them.
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export function escapeControlCharacters(value) {
  return String(value).replaceAll(CONTROL_CHARACTERS, (character) => {
    const code = character.codePointAt(0);
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u{${code.toString(16).padStart(4, "0")}}`;
  });
}

export function sanitizeForDisplay(value, { maxLength = 8192 } = {}) {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new TypeError("maxLength must be a positive integer.");
  const escaped = escapeControlCharacters(value);
  return escaped.length <= maxLength
    ? { text: escaped, truncated: false }
    : { text: escaped.slice(0, maxLength), truncated: true };
}

export function redactSecrets(value) {
  return String(value)
    .replaceAll(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH)[A-Z0-9_]*)=\S+/gi, "$1=[redacted]")
    .replaceAll(/(--?(?:token|secret|password|pass|api-key|authorization))(?:=|\s+)\S+/gi, "$1 [redacted]")
    .replaceAll(/((?:Authorization|PRIVATE-TOKEN|JOB-TOKEN):\s*(?:Bearer\s+|Basic\s+)?)[^\s"']+/gi, "$1[redacted]")
    .replaceAll(/(https?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replaceAll(/(https?:\/\/[^\s?]+)\?\S+/gi, "$1?[redacted]");
}
