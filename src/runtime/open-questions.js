// @ts-check

// A plan often ends with the things its author could not decide: "Offene
// Fragen", "Open questions". Those are for a person, one at a time, before the
// run goes on. This reads them out of a step's text so a gate can ask each
// one; it never invents a question the text does not contain.

const HEADING = /^\s{0,3}(?:#{1,6}\s*|\*\*\s*)?(?:offene\s+fragen|r[uü]ckfragen|fragen|open\s+questions?|clarifying\s+questions?|questions?|unclear\s+points?)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;
const ANY_HEADING = /^\s{0,3}(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
const NOTHING = /^(?:keine|none|n\/a|nichts|-|—|no open questions\.?)\.?$/i;

export const MAX_QUESTIONS = 12;
const MAX_LENGTH = 600;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractOpenQuestions(text) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  const questions = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!HEADING.test(lines[index])) continue;
    let current;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (ANY_HEADING.test(line) && !HEADING.test(line)) break;
      if (HEADING.test(line)) break;
      const item = ITEM.exec(line);
      if (item) {
        if (current !== undefined) questions.push(current);
        current = item[1].trim();
      } else if (current !== undefined && /^\s+\S/.test(line)) {
        current = `${current} ${line.trim()}`;
      } else if (line.trim() === "" && current !== undefined) {
        questions.push(current);
        current = undefined;
      }
    }
    if (current !== undefined) questions.push(current);
  }
  return questions
    .map((question) => question.replace(/\s+/g, " ").slice(0, MAX_LENGTH))
    .filter((question) => question !== "" && !NOTHING.test(question))
    .slice(0, MAX_QUESTIONS);
}
