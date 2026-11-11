import type { Parent, PhrasingContent, Root, RootContent } from "mdast";
import { parseWikilinks, resolveWikilink, type Wikilink } from "./wikilinks";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "definition", "image"]);

export interface WikilinkOptions {
  allPaths: string[];
  fromPath: string;
}

export function remarkWikilinks({ allPaths, fromPath }: WikilinkOptions) {
  const toNodes = (link: Wikilink): PhrasingContent[] => {
    const resolved = resolveWikilink(link.target, fromPath, allPaths);
    const unresolved = resolved === null ? "true" : undefined;
    const path = resolved ?? link.target;
    const label = link.alias ?? (link.heading ? `${link.target}#${link.heading}` : link.target);
    if (link.embed && IMAGE_EXT.test(link.target)) {
      return [
        {
          type: "image",
          url: `#embed:${encodeURIComponent(path)}`,
          alt: link.alias ?? link.target,
          data: {
            hProperties: {
              "data-wikilink": link.target,
              "data-embed": "true",
              "data-unresolved": unresolved,
              className: ["wikilink-embed"],
            },
          },
        },
      ];
    }
    const heading = link.heading ? `&h=${encodeURIComponent(link.heading)}` : "";
    return [
      {
        type: "link",
        url: `#wikilink:${encodeURIComponent(path)}${heading}`,
        children: [{ type: "text", value: label }],
        data: {
          hProperties: {
            "data-wikilink": link.target,
            "data-embed": link.embed ? "true" : undefined,
            "data-unresolved": unresolved,
            className: unresolved ? ["wikilink", "wikilink-unresolved"] : ["wikilink"],
          },
        },
      },
    ];
  };

  const splitText = (value: string): RootContent[] => {
    const links = parseWikilinks(value);
    if (links.length === 0) return [{ type: "text", value }];
    const out: RootContent[] = [];
    let cursor = 0;
    for (const link of links) {
      if (link.start > cursor) out.push({ type: "text", value: value.slice(cursor, link.start) });
      out.push(...toNodes(link));
      cursor = link.end;
    }
    if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
    return out;
  };

  const walk = (parent: Parent) => {
    parent.children = parent.children.flatMap((child): RootContent[] => {
      if (child.type === "text") return splitText(child.value);
      if (!SKIP.has(child.type) && "children" in child) walk(child as Parent);
      return [child];
    });
  };

  return (tree: Root) => {
    walk(tree);
  };
}
