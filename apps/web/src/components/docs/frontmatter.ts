export type FrontmatterValue = string | string[] | boolean | number | null;

export interface SplitFrontmatter {
  properties: Record<string, FrontmatterValue>;
  body: string;
}

const OPEN = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY = /^([\p{L}_][\p{L}\p{N} _.-]*):(?:[ \t]+(.*))?$/u;
const ITEM = /^\s*-(?:[ \t]+(.*))?$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function unquote(value: string): string {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return value;
}

// ponytail: inline lists split on every comma, so quoted items containing commas break. Upgrade with a real YAML parser if needed.
function parseInline(value: string): FrontmatterValue {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (value === "null" || value === "~") return null;
  if (NUMBER.test(value)) return Number(value);
  return unquote(value);
}

function parseBlock(lines: string[]): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  let key: string | null = null;
  let list: string[] | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = ITEM.exec(line);
    if (item) {
      // Orphan items and unsupported lines are skipped, not fatal.
      if (key === null) continue;
      list ??= [];
      list.push(unquote((item[1] ?? "").trim()));
      continue;
    }
    // Indented lines belong to an unsupported construct (nested map, block scalar); skip them.
    if (/^\s/.test(line)) continue;
    if (key !== null) out[key] = list;
    key = null;
    list = null;
    const kv = KEY.exec(line);
    if (!kv) continue;
    const value = (kv[2] ?? "").trim();
    if (value === "") {
      key = kv[1] ?? null;
    } else {
      out[kv[1] ?? ""] = parseInline(value);
    }
  }
  if (key !== null) out[key] = list;
  return out;
}

// Never throws. Absent frontmatter leaves the text unchanged; a block that fails to parse is still stripped.
export function splitFrontmatter(text: string): SplitFrontmatter {
  const match = OPEN.exec(text);
  if (!match) return { properties: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    return { properties: parseBlock((match[1] ?? "").split(/\r?\n/)), body };
  } catch {
    return { properties: {}, body };
  }
}
