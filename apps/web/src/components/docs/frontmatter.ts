export type FrontmatterValue = string | string[] | boolean | number | null;

export interface SplitFrontmatter {
  properties: Record<string, FrontmatterValue>;
  body: string;
}

const OPEN = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY = /^([A-Za-z_][\w .-]*):(?:[ \t]+(.*))?$/;
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
      if (key === null) throw new Error("list item without key");
      list ??= [];
      list.push(unquote((item[1] ?? "").trim()));
      continue;
    }
    if (key !== null) out[key] = list;
    key = null;
    list = null;
    const kv = KEY.exec(line);
    if (!kv) throw new Error(`unparseable line: ${line}`);
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

// Never throws. Malformed or absent frontmatter yields `{}` and the text unchanged.
export function splitFrontmatter(text: string): SplitFrontmatter {
  try {
    const match = OPEN.exec(text);
    if (!match) return { properties: {}, body: text };
    const properties = parseBlock((match[1] ?? "").split(/\r?\n/));
    return { properties, body: text.slice(match[0].length) };
  } catch {
    return { properties: {}, body: text };
  }
}
