import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown } from "../src/ui/markdown.js";
import { CLIENT_CHAT } from "../src/ui/page/client-chat.js";

// An agent's reply is Markdown. The reader returns data, never markup.

test("blocks: headings, paragraphs, lists, code, quotes", () => {
  const blocks = parseMarkdown("# Plan\nFirst line\nsecond line\n\n- one\n- two\n  more\n1. a\n2. b\n\n> note\n\n```js\nconst x = 1;\n```");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "list", "list", "quote", "code"]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[5].text, "const x = 1;");
  assert.equal(blocks[5].language, "js");
});

test("inline: code, bold, italic and https links", () => {
  const [paragraph] = parseMarkdown("Run `npm test` and **check** the *log* at [docs](https://example.com/a?b=1).");
  const kinds = paragraph.children.map((node) => Object.keys(node)[0]);
  assert.deepEqual(kinds, ["text", "code", "text", "bold", "text", "italic", "text", "link", "text"]);
  assert.equal(paragraph.children[1].code, "npm test");
  assert.equal(paragraph.children[7].link, "https://example.com/a?b=1");
});

test("nothing becomes markup: html stays text, and only http(s) links are links", () => {
  const [paragraph] = parseMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](http://a.b)');
  const links = paragraph.children.filter((node) => node.link);
  assert.deepEqual(links.map((node) => node.link), ["http://a.b"]);
  assert.ok(paragraph.children.some((node) => node.text?.includes("<img src=x onerror=alert(1)>")));
});

test("a reply still being written: an open fence is code to the end, a lone star is text", () => {
  const blocks = parseMarkdown("Before\n\n```\nunfinished");
  assert.equal(blocks.at(-1).type, "code");
  assert.equal(blocks.at(-1).text, "unfinished");
  assert.equal(parseMarkdown("2 * 3 * 4")[0].children.length, 1);
  assert.deepEqual(parseMarkdown(""), []);
});

test("the page embeds the same function, and builds elements from the tree only", () => {
  assert.ok(CLIENT_CHAT.includes("function parseMarkdown"));
  assert.ok(CLIENT_CHAT.includes("function renderMarkdown"));
  assert.doesNotMatch(CLIENT_CHAT.slice(CLIENT_CHAT.indexOf("function renderMarkdown"), CLIENT_CHAT.indexOf("function callChips")), /innerHTML/);
});
