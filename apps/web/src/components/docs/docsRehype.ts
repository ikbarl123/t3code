import type { Element, Root } from "hast";

import { slugifyHeading } from "./backlinks";

const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "blockquote",
  "table",
  "ul",
  "ol",
  "hr",
  "img",
]);

const textOf = (node: Element | Root["children"][number]): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

/**
 * Adds `data-line` (full-file line, so `lineOffset` covers frontmatter) to blocks and GitHub-style
 * `id`s to headings. Duplicate headings are counted in document order, matching outline().
 */
// ponytail: heading slugs come from rendered text, so headings with inline markup can slug differently from outline(). Fine for plain headings.
export function rehypeNoteAnchors(options: { readonly lineOffset: number }) {
  return (tree: Root) => {
    const seen = new Map<string, number>();
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.position && BLOCKS.has(child.tagName)) {
          child.properties.dataLine = child.position.start.line + options.lineOffset;
        }
        if (/^h[1-6]$/.test(child.tagName)) {
          const base = slugifyHeading(textOf(child));
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          child.properties.id = n ? `${base}-${n}` : base;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}
