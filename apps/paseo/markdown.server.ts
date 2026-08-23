/**
 * Markdown and SVG artifacts, turned into a page Chrome can rasterise.
 *
 * Claude writes reports as Markdown far more often than as HTML, so a canvas
 * that only understood HTML would miss most of what an agent actually produces.
 * This is a deliberately small converter — no dependency is allowed in a plugin
 * bundle, and a report needs headings, lists, tables, code and links, not a
 * complete CommonMark implementation.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ESCAPES[character]!);
}

/** Inline markup, applied to already-escaped text. */
function inline(text: string): string {
  const code: string[] = [];
  // Code spans first, so nothing inside them is treated as markup.
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, body: string) => {
    code.push(body);
    return `\u0000${code.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^*_])(\*|_)(?=\S)([^*_]*?\S)\2/g, "$1<em>$3</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `<code>${escapeHtml(code[Number(index)] ?? "")}</code>`);
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  const closeList = (stack: string[]) => {
    while (stack.length) html.push(`</${stack.pop()}>`);
  };
  const listStack: string[] = [];

  while (index < lines.length) {
    const line = lines[index]!;

    // Fenced code
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      closeList(listStack);
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Table: a header row followed by a delimiter row
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1]!)) {
      closeList(listStack);
      const head = tableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /\|/.test(lines[index]!) && lines[index]!.trim() !== "") {
        rows.push(tableRow(lines[index]!));
        index += 1;
      }
      html.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList(listStack);
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      closeList(listStack);
      html.push("<hr>");
      index += 1;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList(listStack);
      const body: string[] = [quote[1]!];
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]!);
      const tag = ordered ? "ol" : "ul";
      if (listStack[listStack.length - 1] !== tag) {
        closeList(listStack);
        listStack.push(tag);
        html.push(`<${tag}>`);
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[3]!);
      html.push(
        task
          ? `<li class="task">${task[1]!.toLowerCase() === "x" ? "☑" : "☐"} ${inline(task[2]!)}</li>`
          : `<li>${inline(bullet[3]!)}</li>`,
      );
      index += 1;
      continue;
    }

    if (line.trim() === "") {
      closeList(listStack);
      index += 1;
      continue;
    }

    // Paragraph: gather until a blank line or a block starter.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^\s*(```|~~~|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s)/.test(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    if (paragraph.length) {
      closeList(listStack);
      html.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      continue;
    }
    index += 1;
  }
  closeList(listStack);
  return html.join("\n");
}

export type PageTheme = {
  background: string;
  foreground: string;
  muted: string;
  accent: string;
};

const FALLBACK: PageTheme = { background: "#ffffff", foreground: "#111827", muted: "#6b7280", accent: "#2563eb" };

/** Only hex colours reach the generated CSS — the values come from the client. */
function safeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

/**
 * Wrap rendered body HTML in a readable document. `baseHref` keeps relative
 * images and links working even though the file being rendered is a temporary
 * one in another directory.
 */
export function wrapDocument(
  body: string,
  options: { title: string; baseHref: string; theme?: Partial<PageTheme>; wide?: boolean },
): string {
  const theme: PageTheme = {
    background: safeColor(options.theme?.background, FALLBACK.background),
    foreground: safeColor(options.theme?.foreground, FALLBACK.foreground),
    muted: safeColor(options.theme?.muted, FALLBACK.muted),
    accent: safeColor(options.theme?.accent, FALLBACK.accent),
  };
  return `<!doctype html>
<html><head><meta charset="utf-8">
<base href="${escapeHtml(options.baseHref)}">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px ${options.wide ? "48" : "56"}px 56px;
    background: ${theme.background}; color: ${theme.foreground};
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .6em; font-weight: 650; letter-spacing: -0.01em; }
  h1 { font-size: 2em; margin-top: 0; }
  h2 { font-size: 1.45em; }
  h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
  ul, ol { padding-left: 1.4em; }
  li { margin: .25em 0; }
  li.task { list-style: none; margin-left: -1.2em; }
  a { color: ${theme.accent}; text-decoration: none; border-bottom: 1px solid ${theme.accent}55; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
         background: ${theme.foreground}14; padding: .15em .35em; border-radius: 4px; }
  pre { background: ${theme.foreground}0d; border: 1px solid ${theme.foreground}1a; border-radius: 10px;
        padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: .85em; line-height: 1.5; }
  blockquote { border-left: 3px solid ${theme.accent}66; padding-left: 14px; color: ${theme.muted}; }
  table { border-collapse: collapse; width: 100%; font-size: .93em; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid ${theme.foreground}1a; vertical-align: top; }
  th { font-weight: 620; color: ${theme.muted}; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; }
  tbody tr:last-child td { border-bottom: none; }
  hr { border: none; border-top: 1px solid ${theme.foreground}1f; margin: 2em 0; }
  img, svg { max-width: 100%; height: auto; }
  del { color: ${theme.muted}; }
</style></head>
<body>${body}</body></html>`;
}

/** An SVG file shown on its own, centred, at a sensible size. */
export function wrapSvg(svg: string, options: { title: string; baseHref: string; theme?: Partial<PageTheme> }): string {
  return wrapDocument(`<div style="display:flex;justify-content:center">${svg}</div>`, { ...options, wide: true });
}
