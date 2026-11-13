import { describe, expect, it } from "vite-plus/test";
import { parseWikilinks, resolveWikilink } from "./wikilinks";

describe("parseWikilinks", () => {
  it("parses target, heading, alias, and embed forms", () => {
    const links = parseWikilinks("[[a]] [[b|B]] [[c#H]] [[d#H|D]] ![[img.png]]");
    expect(links.map((l) => [l.target, l.heading, l.alias, l.embed])).toEqual([
      ["a", undefined, undefined, false],
      ["b", undefined, "B", false],
      ["c", "H", undefined, false],
      ["d", "H", "D", false],
      ["img.png", undefined, undefined, true],
    ]);
  });

  it("ignores links in fenced and inline code", () => {
    const text = "`[[no]]` [[yes]]\n```\n[[nope]]\n```\n~~~\n[[nada]]\n~~~\n";
    expect(parseWikilinks(text).map((l) => l.target)).toEqual(["yes"]);
  });

  it("reports offsets into the original text", () => {
    const text = "x `y` [[z]]";
    const [link] = parseWikilinks(text);
    expect(text.slice(link?.start, link?.end)).toBe("[[z]]");
  });
});

describe("resolveWikilink", () => {
  const all = ["a/Note.md", "b/note.md", "deep/x/Other.md", "img/pic.png", "Root.md"];

  it("matches case-insensitively with optional .md", () => {
    expect(resolveWikilink("root", "q.md", all)).toBe("Root.md");
    expect(resolveWikilink("ROOT.md", "q.md", all)).toBe("Root.md");
  });

  it("prefers the closest folder on ties", () => {
    expect(resolveWikilink("note", "a/start.md", all)).toBe("a/Note.md");
    expect(resolveWikilink("note", "b/start.md", all)).toBe("b/note.md");
  });

  it("prefers the shortest path when no folder matches", () => {
    expect(resolveWikilink("other", "z.md", all)).toBe("deep/x/Other.md");
  });

  it("matches full vault-relative path", () => {
    expect(resolveWikilink("deep/x/other", "z.md", all)).toBe("deep/x/Other.md");
  });

  it("resolves non-md targets by full filename", () => {
    expect(resolveWikilink("pic.png", "z.md", all)).toBe("img/pic.png");
    expect(resolveWikilink("pic", "z.md", all)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveWikilink("missing", "z.md", all)).toBeNull();
  });
});
