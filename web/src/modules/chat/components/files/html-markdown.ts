/**
 * Turn what someone edited in the file panel's rich-text editor back into
 * Markdown, the format the file is stored in.
 *
 * It reads the editor's DOM through the few Node members it needs, so it
 * runs on a real element in the browser and on a plain object tree in tests.
 */
export interface MarkdownSourceNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<MarkdownSourceNode>;
  getAttribute?: (name: string) => string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const BLOCK_TAGS: Record<string, true> = {
  P: true, DIV: true, SECTION: true, ARTICLE: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
  UL: true, OL: true, LI: true, BLOCKQUOTE: true, PRE: true, TABLE: true, HR: true, FIGURE: true,
};
/** Controls the preview draws around content (copy buttons, icons) are not content. */
const SKIPPED_TAGS: Record<string, true> = { BUTTON: true, SVG: true, svg: true, SCRIPT: true, STYLE: true, TEMPLATE: true };

const children = (node: MarkdownSourceNode) => Array.from(node.childNodes);
const tag = (node: MarkdownSourceNode) => node.nodeName.toUpperCase();
const isBlock = (node: MarkdownSourceNode) => node.nodeType === ELEMENT_NODE && BLOCK_TAGS[tag(node)] === true;

function escapeText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(/([*`])/g, "\\$1")
    .replaceAll(/(^|\W)_|_(?=\W|$)/g, (match) => match.replace("_", "\\_"));
}

function inline(node: MarkdownSourceNode): string {
  if (node.nodeType === TEXT_NODE) return escapeText((node.textContent ?? "").replaceAll(/\s+/g, " "));
  if (node.nodeType !== ELEMENT_NODE || SKIPPED_TAGS[node.nodeName]) return "";
  const content = () => children(node).map(inline).join("");
  switch (tag(node)) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return wrap(content(), "**");
    case "EM":
    case "I":
      return wrap(content(), "*");
    case "DEL":
    case "S":
      return wrap(content(), "~~");
    case "CODE":
      return `\`${(node.textContent ?? "").replaceAll("`", "\\`")}\``;
    case "A": {
      const href = node.getAttribute?.("href");
      const text = content();
      return href ? `[${text}](${href})` : text;
    }
    default:
      return content();
  }
}

/** Emphasis markers hug the words: `** bold **` is not bold in Markdown. */
function wrap(text: string, marker: string): string {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : text;
}

function paragraph(nodes: MarkdownSourceNode[]): string {
  return nodes.map(inline).join("").replaceAll(/[ \t]+\n/g, "\n").replaceAll(/\n[ \t]+/g, "\n").trim();
}

function list(node: MarkdownSourceNode, depth: number): string {
  const ordered = tag(node) === "OL";
  let number = Number(node.getAttribute?.("start") ?? 1) || 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const item of children(node)) {
    if (item.nodeType !== ELEMENT_NODE || tag(item) !== "LI") continue;
    const marker = ordered ? `${number++}. ` : "- ";
    const inlineNodes: MarkdownSourceNode[] = [];
    const nested: string[] = [];
    for (const child of children(item)) {
      if (child.nodeType === ELEMENT_NODE && (tag(child) === "UL" || tag(child) === "OL")) nested.push(list(child, depth + 1));
      else if (isBlock(child)) inlineNodes.push(...children(child), { nodeType: TEXT_NODE, nodeName: "#text", textContent: " ", childNodes: [] });
      else inlineNodes.push(child);
    }
    lines.push(`${indent}${marker}${paragraph(inlineNodes).replaceAll("\n", `\n${indent}  `)}`, ...nested);
  }
  return lines.join("\n");
}

function table(node: MarkdownSourceNode): string {
  const rows: string[][] = [];
  const collect = (current: MarkdownSourceNode) => {
    for (const child of children(current)) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      if (tag(child) === "TR") {
        rows.push(
          children(child)
            .filter((cell) => cell.nodeType === ELEMENT_NODE && (tag(cell) === "TD" || tag(cell) === "TH"))
            .map((cell) => paragraph(children(cell)).replaceAll("\n", " ").replaceAll("|", "\\|")),
        );
      } else collect(child);
    }
  };
  collect(node);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function blocks(node: MarkdownSourceNode, depth = 0): string[] {
  const out: string[] = [];
  let run: MarkdownSourceNode[] = [];
  const flush = () => {
    const text = paragraph(run);
    if (text) out.push(text);
    run = [];
  };
  for (const child of children(node)) {
    if (child.nodeType === ELEMENT_NODE && SKIPPED_TAGS[child.nodeName]) continue;
    if (!isBlock(child)) {
      run.push(child);
      continue;
    }
    flush();
    const name = tag(child);
    if (/^H[1-6]$/.test(name)) {
      const text = paragraph(children(child)).replaceAll("\n", " ");
      if (text) out.push(`${"#".repeat(Number(name[1]))} ${text}`);
    } else if (name === "UL" || name === "OL") {
      const text = list(child, 0);
      if (text) out.push(text);
    } else if (name === "PRE") {
      const code = children(child).find((candidate) => tag(candidate) === "CODE");
      const language = code?.getAttribute?.("class")?.match(/language-([\w+-]+)/)?.[1] ?? "";
      const text = (child.textContent ?? "").replace(/\n$/, "");
      out.push(`\`\`\`${language}\n${text}\n\`\`\``);
    } else if (name === "BLOCKQUOTE") {
      const inner = blocks(child, depth + 1).join("\n\n");
      if (inner) out.push(inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
    } else if (name === "TABLE") {
      const text = table(child);
      if (text) out.push(text);
    } else if (name === "HR") {
      out.push("---");
    } else {
      out.push(...blocks(child, depth));
    }
  }
  flush();
  return out;
}

/** Markdown for the edited content, ending with one newline. */
export function htmlToMarkdown(root: MarkdownSourceNode): string {
  const text = blocks(root).join("\n\n").trim();
  return text ? `${text}\n` : "";
}
