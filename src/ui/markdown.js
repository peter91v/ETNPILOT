// A deliberately small Markdown subset built with DOM nodes only. Raw HTML
// remains text; links accept HTTP(S), mailto, and local anchors only.
export function renderChatMarkdown(text, document = globalThis.document) {
  const root = document.createElement("div");
  root.className = "said markdown";
  let nodes = 0;
  const inline = (parent, source) => {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let at = 0;
    for (const match of source.matchAll(pattern)) {
      if (++nodes > 2000) break;
      parent.append(document.createTextNode(source.slice(at, match.index)));
      const value = match[0];
      let node;
      if (value.startsWith("`")) { node = document.createElement("code"); node.textContent = value.slice(1, -1); }
      else if (value.startsWith("**")) { node = document.createElement("strong"); node.textContent = value.slice(2, -2); }
      else if (value.startsWith("*")) { node = document.createElement("em"); node.textContent = value.slice(1, -1); }
      else {
        const link = /^\[([^\]]+)\]\((.+)\)$/.exec(value);
        let safe = link[2].startsWith("#");
        try { safe ||= ["http:", "https:", "mailto:"].includes(new URL(link[2]).protocol); } catch { /* text */ }
        node = document.createElement(safe ? "a" : "span"); node.textContent = link[1];
        if (safe) { node.setAttribute("href", link[2]); node.setAttribute("rel", "noopener noreferrer"); }
      }
      parent.append(node); at = match.index + value.length;
    }
    parent.append(document.createTextNode(source.slice(at)));
  };
  let code;
  let list;
  for (const line of String(text).slice(0, 256 * 1024).split("\n").slice(0, 2000)) {
    if (line.startsWith("```")) {
      list = undefined;
      if (code) code = undefined;
      else { const pre = document.createElement("pre"); code = document.createElement("code"); pre.append(code); root.append(pre); }
    } else if (code) code.textContent += `${line}\n`;
    else {
      const bullet = /^[-*] (.*)$/.exec(line);
      if (bullet) {
        if (!list) { list = document.createElement("ul"); root.append(list); }
        const item = document.createElement("li"); inline(item, bullet[1]); list.append(item);
      } else {
        list = undefined;
        const heading = /^(#{1,6}) (.*)$/.exec(line);
        const paragraph = document.createElement(heading ? `h${heading[1].length}` : "p");
        inline(paragraph, heading ? heading[2] : line); root.append(paragraph);
      }
    }
  }
  return root;
}
