export interface Wikilink {
  raw: string;
  target: string;
  heading?: string | undefined;
  alias?: string | undefined;
  embed: boolean;
  start: number;
  end: number;
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

// Same-length copy with fenced code blanked (offsets preserved).
export function maskFences(text: string): string {
  let fence: string | null = null;
  const lines = text.split(/(?<=\n)/).map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1] ?? null;
        return blank(line);
      }
      return line;
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
    if (close && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length) {
      fence = null;
    }
    return blank(line);
  });
  return lines.join("");
}

// Same-length copy with fenced and inline code blanked.
export function maskCode(text: string): string {
  return maskFences(text).replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank);
}

const LINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

export function parseWikilinks(text: string): Wikilink[] {
  const out: Wikilink[] = [];
  for (const m of maskCode(text).matchAll(LINK)) {
    const start = m.index ?? 0;
    const inner = m[2] ?? "";
    const pipe = inner.indexOf("|");
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim() || undefined;
    const hash = left.indexOf("#");
    const target = (hash === -1 ? left : left.slice(0, hash)).trim();
    const heading = hash === -1 ? undefined : left.slice(hash + 1).trim() || undefined;
    if (!target && !heading) continue;
    const end = start + (m[0]?.length ?? 0);
    out.push({
      raw: text.slice(start, end),
      target,
      heading,
      alias,
      embed: m[1] === "!",
      start,
      end,
    });
  }
  return out;
}

const NOTE_EXT = /\.md$/;

// Empty target (`[[#heading]]`) means the same note. Null when nothing matches.
export function resolveWikilink(
  target: string,
  fromPath: string,
  allPaths: string[],
): string | null {
  // A dotted note name ("v1.2") is a note first; fall back to a file link.
  return (
    resolveAs(target, fromPath, allPaths, true) ?? resolveAs(target, fromPath, allPaths, false)
  );
}

function resolveAs(
  target: string,
  fromPath: string,
  allPaths: string[],
  noteFirst: boolean,
): string | null {
  const clean = target.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!clean) return fromPath;
  const ext = /\.([a-z0-9]{1,5})$/.exec(clean)?.[1];
  const isNote = !ext || ext === "md" || noteFirst;
  const key = isNote ? clean.replace(NOTE_EXT, "") : clean;
  const keyName = key.split("/").pop() ?? key;
  const pathKey = (p: string) => (isNote ? p.toLowerCase().replace(NOTE_EXT, "") : p.toLowerCase());
  const pool = allPaths.filter((p) => !isNote || NOTE_EXT.test(p.toLowerCase()));

  const full = pool.filter((p) => pathKey(p) === key);
  const byName = pool.filter((p) => {
    const pk = pathKey(p);
    if ((pk.split("/").pop() ?? pk) !== keyName) return false;
    return !key.includes("/") || pk.endsWith(`/${key}`);
  });
  const matches = full.length > 0 ? full : byName;
  if (matches.length === 0) return null;

  const dirs = (p: string) => p.split("/").slice(0, -1);
  const fromDirs = dirs(fromPath);
  const sharedDepth = (a: string[]) => {
    let i = 0;
    while (i < a.length && i < fromDirs.length && a[i] === fromDirs[i]) i++;
    return i;
  };
  matches.sort(
    (a, b) =>
      dirs(a).length - dirs(b).length ||
      sharedDepth(dirs(b)) - sharedDepth(dirs(a)) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  return matches[0] ?? null;
}
