import { describe, expect, it } from "vite-plus/test";
import { buildLinkIndex, outline } from "./backlinks";

describe("buildLinkIndex", () => {
  it("builds backlinks, outgoing links, and tags", () => {
    const index = buildLinkIndex([
      { path: "a/One.md", text: "---\ntags: [topic]\n---\nlinks to [[Two]]\n#solo" },
      { path: "b/Two.md", text: "back to [[one]] and [[Ghost]] and [[One#x]]" },
    ]);
    expect(index.outgoing.get("a/One.md")).toEqual(["b/Two.md"]);
    expect(index.outgoing.get("b/Two.md")).toEqual(["a/One.md"]);
    expect(index.backlinks.get("b/Two.md")).toEqual([
      { from: "a/One.md", line: 4, context: "links to [[Two]]" },
    ]);
    expect(index.backlinks.get("a/One.md")).toEqual([
      { from: "b/Two.md", line: 1, context: "back to [[one]] and [[Ghost]] and [[One#x]]" },
      { from: "b/Two.md", line: 1, context: "back to [[one]] and [[Ghost]] and [[One#x]]" },
    ]);
    expect(index.tags.get("topic")).toEqual(["a/One.md"]);
    expect(index.tags.get("solo")).toEqual(["a/One.md"]);
  });

  it("does not count self-links as backlinks", () => {
    const index = buildLinkIndex([{ path: "x.md", text: "[[x]]" }]);
    expect(index.backlinks.get("x.md")).toEqual([]);
  });
});

describe("outline", () => {
  it("returns headings with GitHub-style slugs, skipping fenced code", () => {
    const body = "# Hello World\n```\n# not heading\n```\n## Hello World\n### Sub: `x`!";
    expect(outline(body)).toEqual([
      { level: 1, text: "Hello World", slug: "hello-world" },
      { level: 2, text: "Hello World", slug: "hello-world-1" },
      { level: 3, text: "Sub: `x`!", slug: "sub-x" },
    ]);
  });
});
