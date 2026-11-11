import type { FrontmatterValue } from "./frontmatter";
import { maskCode } from "./wikilinks";

// `#` must not follow a word char, `&`, `/`, `#` or `[`, so URL anchors and `[[x#heading]]` are skipped.
const TAG = /(?<![\p{L}\p{N}_&/#[])#([\p{L}_][\p{L}\p{N}_\/-]*)/gu;
const URL_OR_LINK_TARGET = /\]\([^)]*\)|[a-z][a-z0-9+.-]*:\/\/\S+/gi;

function normalize(tag: string): string {
  return tag
    .trim()
    .replace(/^#/, "")
    .replace(/[/-]+$/, "")
    .toLowerCase();
}

// Returns tags without `#`, lowercased, deduped. Nested tags keep their slashes (`nested/tag`).
export function extractTags(body: string, frontmatter: Record<string, FrontmatterValue>): string[] {
  const fm = frontmatter.tags;
  const fmTags = typeof fm === "string" ? fm.split(/[\s,]+/) : Array.isArray(fm) ? fm : [];
  const masked = maskCode(body).replace(URL_OR_LINK_TARGET, (m) => " ".repeat(m.length));
  const inline = [...masked.matchAll(TAG)].map((m) => normalize(m[1] ?? ""));
  return [...new Set([...fmTags.map(normalize), ...inline])].filter(Boolean);
}
