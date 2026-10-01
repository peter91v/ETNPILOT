// A small Markdown reader for what an agent writes in a chat reply: headings,
// paragraphs, lists, fenced and inline code, bold, italic and links. It returns
// a tree of plain data — never markup — and the page builds elements from it
// with textContent, so nothing a model wrote can become HTML or a script.
//
// It is one self-contained function on purpose: the page embeds its source
// text (functions have no imports in the browser) and the tests call the very
// same function in Node.

export function parseMarkdown(source) {
  const blocks = [];
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");

  function inline(text) {
    const out = [];
    let rest = text;
    const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([^*\n]+?)\*\*|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
    while (rest.length > 0) {
      const match = pattern.exec(rest);
      if (!match) { out.push({ text: rest }); break; }
      if (match.index > 0) out.push({ text: rest.slice(0, match.index) });
      if (match[2] !== undefined) out.push({ code: match[2].trim() });
      else if (match[3] !== undefined) out.push({ bold: inline(match[3]) });
      else if (match[4] !== undefined) out.push({ italic: inline(match[4]) });
      else out.push({ link: match[6], children: inline(match[5]) });
      rest = rest.slice(match.index + match[0].length);
    }
    return out;
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") { index += 1; continue; }

    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      // An unfinished fence — a reply still being written — is code to the end.
      while (index < lines.length && !new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", language: fence[2] || undefined, text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: inline(heading[2]) });
      index += 1;
      continue;
    }

    const bullet = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (index < lines.length) {
        const item = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[index]);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        const parts = [item[2]];
        index += 1;
        // A continuation line is indented under its item.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/.test(lines[index])) {
          parts.push(lines[index].trim());
          index += 1;
        }
        items.push(inline(parts.join(" ")));
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      const parts = [];
      while (index < lines.length) {
        const next = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
        if (!next) break;
        parts.push(next[1]);
        index += 1;
      }
      blocks.push({ type: "quote", children: inline(parts.join(" ")) });
      continue;
    }

    // A paragraph runs to the next blank line or to the start of another block.
    const parts = [];
    while (index < lines.length && lines[index].trim() !== ""
      && !/^\s{0,3}(`{3,}|~{3,})/.test(lines[index]) && !/^#{1,4}\s/.test(lines[index])
      && !/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/.test(lines[index]) && !/^\s{0,3}>/.test(lines[index])) {
      parts.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: inline(parts.join("\n")) });
  }
  return blocks;
}
