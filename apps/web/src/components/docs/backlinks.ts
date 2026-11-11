import { extractTags } from "./tags";
import { splitFrontmatter } from "./frontmatter";
import { maskFences, parseWikilinks, resolveWikilink } from "./wikilinks";

export interface NoteInput {
  path: string;
  text: string;
}

export interface Backlink {
  from: string;
  line: number;
  context: string;
}

export interface LinkIndex {
  backlinks: Map<string, Backlink[]>;
  outgoing: Map<string, string[]>;
  tags: Map<string, string[]>;
}

export function buildLinkIndex(notes: NoteInput[]): LinkIndex {
  const paths = notes.map((n) => n.path);
  const index: LinkIndex = { backlinks: new Map(), outgoing: new Map(), tags: new Map() };
  for (const p of paths) {
    index.backlinks.set(p, []);
    index.outgoing.set(p, []);
  }

  for (const note of notes) {
    const { properties, body } = splitFrontmatter(note.text);
    const lines = note.text.split("\n");
    const resolvedCache = new Map<string, string | null>();
    const outgoing = new Set<string>();

    for (const link of parseWikilinks(note.text)) {
      let resolved = resolvedCache.get(link.target);
      if (resolved === undefined) {
        resolved = resolveWikilink(link.target, note.path, paths);
        resolvedCache.set(link.target, resolved);
      }
      if (resolved === null || resolved === note.path) continue;
      const line = note.text.slice(0, link.start).split("\n").length;
      index.backlinks.get(resolved)?.push({
        from: note.path,
        line,
        context: (lines[line - 1] ?? "").trim(),
      });
      outgoing.add(resolved);
    }
    index.outgoing.set(note.path, [...outgoing]);

    for (const tag of extractTags(body, properties)) {
      const list = index.tags.get(tag) ?? [];
      if (!list.includes(note.path)) list.push(note.path);
      index.tags.set(tag, list);
    }
  }
  return index;
}

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/;

// GitHub-style slugs; duplicates get `-1`, `-2`, ...
export function outline(body: string): OutlineItem[] {
  const lines = body.split("\n");
  const masked = maskFences(body).split("\n");
  const seen = new Map<string, number>();
  const out: OutlineItem[] = [];
  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (!m || masked[i] !== line) return;
    const text = m[2] ?? "";
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: m[1]?.length ?? 1, text, slug: n ? `${base}-${n}` : base });
  });
  return out;
}
