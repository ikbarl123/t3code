import { describe, expect, it } from "vite-plus/test";
import { splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("parses scalars, inline lists, block lists, and quotes", () => {
    const text = [
      "---",
      'title: "Hello: world"',
      "aliases: [a, 'b c']",
      "tags:",
      "  - x",
      "  - y",
      "draft: true",
      "count: 3",
      "empty:",
      "---",
      "# Body",
    ].join("\n");
    expect(splitFrontmatter(text)).toEqual({
      properties: {
        title: "Hello: world",
        aliases: ["a", "b c"],
        tags: ["x", "y"],
        draft: true,
        count: 3,
        empty: null,
      },
      body: "# Body",
    });
  });

  it("returns text unchanged when there is no frontmatter", () => {
    expect(splitFrontmatter("# hi\n---\nnot fm")).toEqual({
      properties: {},
      body: "# hi\n---\nnot fm",
    });
  });

  it("skips unsupported lines and still strips the block", () => {
    const text = [
      "---",
      "parent:",
      "  child: 1",
      "desc: >",
      "  folded text",
      "título: Olá",
      ": : :",
      "tags:",
      "  - x",
      "---",
      "body",
    ].join("\n");
    expect(splitFrontmatter(text)).toEqual({
      properties: { parent: null, desc: ">", título: "Olá", tags: ["x"] },
      body: "body",
    });
  });

  it("strips a malformed block from the body without leaking YAML", () => {
    const text = "---\n: : :\n  stray indent\n---\nbody";
    expect(splitFrontmatter(text)).toEqual({ properties: {}, body: "body" });
  });
});
