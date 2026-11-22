export interface MarkdownBlock {
  type: "code" | "heading" | "blockquote" | "ul" | "ol" | "hr" | "paragraph";
  text?: string;
  lang?: string;
  level?: number;
  items?: string[];
}

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```([\w.+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join("\n") });
    }
  }

  return blocks;
}

function appendInlineMarkdown(parent: Node, text: string): void {
  // Tokenize inline code, links, bold (** or __), and italic (* or _)
  const pattern =
    /(`[^`\n]+`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*|__([^_\n]+)__)|(\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }

    if (match[1]) {
      const code = document.createElement("code");
      code.className = "md-inline-code";
      code.textContent = match[1].slice(1, -1);
      parent.appendChild(code);
    } else if (match[2]) {
      const a = document.createElement("a");
      a.className = "md-link";
      a.href = match[4];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[3];
      parent.appendChild(a);
    } else if (match[5]) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, match[6] ?? match[7] ?? "");
      parent.appendChild(strong);
    } else if (match[8]) {
      const em = document.createElement("em");
      appendInlineMarkdown(em, match[9] ?? match[10] ?? "");
      parent.appendChild(em);
    }

    lastIdx = pattern.lastIndex;
  }

  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function appendInlineWithLineBreaks(parent: Node, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (idx > 0) parent.appendChild(document.createElement("br"));
    appendInlineMarkdown(parent, line);
  });
}

export function renderMarkdown(container: HTMLElement, markdown: string): void {
  const frag = document.createDocumentFragment();
  const blocks = parseMarkdownBlocks(markdown);

  for (const block of blocks) {
    if (block.type === "code") {
      const wrap = document.createElement("div");
      wrap.className = "md-code-wrap";
      if (block.lang) {
        const hdr = document.createElement("div");
        hdr.className = "md-code-lang";
        hdr.textContent = block.lang;
        wrap.appendChild(hdr);
      }
      const pre = document.createElement("pre");
      pre.className = "md-pre";
      const code = document.createElement("code");
      code.textContent = block.text ?? "";
      pre.appendChild(code);
      wrap.appendChild(pre);
      frag.appendChild(wrap);
    } else if (block.type === "heading") {
      const tag = (block.level ?? 3) <= 2 ? "h3" : "h4";
      const h = document.createElement(tag);
      h.className = `md-heading md-h${Math.min(6, block.level ?? 3)}`;
      appendInlineMarkdown(h, block.text ?? "");
      frag.appendChild(h);
    } else if (block.type === "hr") {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      frag.appendChild(hr);
    } else if (block.type === "blockquote") {
      const bq = document.createElement("blockquote");
      bq.className = "md-quote";
      appendInlineWithLineBreaks(bq, block.text ?? "");
      frag.appendChild(bq);
    } else if (block.type === "ul" || block.type === "ol") {
      const list = document.createElement(block.type);
      list.className = "md-list";
      for (const item of block.items ?? []) {
        const li = document.createElement("li");
        appendInlineMarkdown(li, item);
        list.appendChild(li);
      }
      frag.appendChild(list);
    } else {
      const p = document.createElement("p");
      p.className = "md-p";
      appendInlineWithLineBreaks(p, block.text ?? "");
      frag.appendChild(p);
    }
  }

  container.replaceChildren(frag);
}
