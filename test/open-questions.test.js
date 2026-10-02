import assert from "node:assert/strict";
import test from "node:test";
import { extractOpenQuestions } from "../src/runtime/open-questions.js";

const PLAN = `## Ist-Zustand
- Das Repository ist eine Angular-App.

## Plan
1) Datei: hello.py

## Risiken
- Inkonsistenz, falls sich die Erwartungen ändern.

## Offene Fragen
- Wo soll hello.py liegen? (Repository-Root oder ein Unterordner wie scripts/?)
- Welcher Zweck ist konkret gewünscht? Reines "Hello, World!" oder zusätzliche Funktionalität/Argumente?
- Soll ein bestimmter Python-Interpreter/Version unterstützt werden (z. B. Python 3.10+)?
`;

test("each open question of a plan is read out on its own, and nothing else is", () => {
  const questions = extractOpenQuestions(PLAN);
  assert.equal(questions.length, 3);
  assert.match(questions[0], /^Wo soll hello\.py liegen\?/);
  assert.match(questions[2], /Python 3\.10\+/);
  assert.equal(questions.some((question) => /Inkonsistenz/.test(question)), false, "risks are not questions");
});

test("English headings, numbered items, bold headings and wrapped lines work too", () => {
  assert.deepEqual(extractOpenQuestions("Plan\n\n**Open questions**\n\n1. Which branch?\n2. Is\n   it a rewrite?\n\n## Next\n- not a question"), ["Which branch?", "Is it a rewrite?"]);
  assert.deepEqual(extractOpenQuestions("### Open questions:\n* Only one?"), ["Only one?"]);
});

test("a plan without questions, or one that says there are none, yields none", () => {
  assert.deepEqual(extractOpenQuestions("## Plan\n- do it"), []);
  assert.deepEqual(extractOpenQuestions("## Offene Fragen\n- Keine"), []);
  assert.deepEqual(extractOpenQuestions("## Open questions\nNone."), []);
  assert.deepEqual(extractOpenQuestions(undefined), []);
  assert.deepEqual(extractOpenQuestions(""), []);
});

test("the number and the length of questions are bounded", () => {
  const many = `## Open questions\n${Array.from({ length: 40 }, (_, index) => `- Question ${index}?`).join("\n")}\n`;
  assert.equal(extractOpenQuestions(many).length, 12);
  assert.equal(extractOpenQuestions(`## Open questions\n- ${"x".repeat(5000)}`)[0].length, 600);
});
