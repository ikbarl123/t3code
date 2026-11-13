import type { Root } from "mdast";
import { describe, expect, it } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { remarkWikilinks } from "./remarkWikilinks";

const run = (md: string, allPaths = ["a/Note.md", "img/pic.png"]) => {
  const tree = fromMarkdown(md) as Root;
  remarkWikilinks({ allPaths, fromPath: "a/Start.md" })(tree);
  return tree;
};

describe("remarkWikilinks", () => {
  it("turns resolved links into link nodes with wikilink hProperties", () => {
    const tree = run("see [[note|the note]]");
    const para = tree.children[0] as unknown as { children: unknown[] };
    const link = para.children[1] as {
      type: string;
      url: string;
      children: unknown[];
      data: { hProperties: Record<string, unknown> };
    };
    expect(link.type).toBe("link");
    expect(link.url).toBe("#wikilink:a%2FNote.md");
    expect(link.children).toEqual([{ type: "text", value: "the note" }]);
    expect(link.data.hProperties["data-wikilink"]).toBe("note");
    expect(link.data.hProperties["data-unresolved"]).toBeUndefined();
  });

  it("marks unresolved links and appends heading", () => {
    const tree = run("[[ghost#Sec]]");
    const link = (
      tree.children[0] as {
        children: Array<{ url: string; data: { hProperties: Record<string, unknown> } }>;
      }
    ).children[0];
    expect(link?.url).toBe("#wikilink:ghost&h=Sec");
    expect(link?.data.hProperties["data-unresolved"]).toBe("true");
  });

  it("converts image embeds to image nodes", () => {
    const tree = run("![[pic.png]]");
    const img = (tree.children[0] as { children: Array<{ type: string; url: string }> })
      .children[0];
    expect(img?.type).toBe("image");
    expect(img?.url).toBe("#embed:img%2Fpic.png");
  });

  it("leaves code and existing links untouched", () => {
    const tree = run("`[[note]]` and [x](y) [[note]]");
    const kids = (tree.children[0] as { children: Array<{ type: string }> }).children;
    expect(kids.map((k) => k.type)).toEqual(["inlineCode", "text", "link", "text", "link"]);
  });
});
