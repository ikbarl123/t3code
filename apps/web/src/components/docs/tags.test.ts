import { describe, expect, it } from "vite-plus/test";
import { extractTags } from "./tags";

describe("extractTags", () => {
  it("finds inline and nested tags, skipping headings, code, and URL anchors", () => {
    const body = [
      "# Heading not a tag",
      "Some #Alpha and #proj/sub-x text.",
      "`#inline-code`",
      "```",
      "#fenced",
      "```",
      "https://x.dev/page#anchor and [l](https://y.dev#frag)",
      "[[note#section]]",
    ].join("\n");
    expect(extractTags(body, {})).toEqual(["alpha", "proj/sub-x"]);
  });

  it("merges frontmatter tags and dedupes", () => {
    expect(extractTags("#a #b", { tags: ["b", "#c"] })).toEqual(["b", "c", "a"]);
  });

  it("accepts a frontmatter tags string", () => {
    expect(extractTags("", { tags: "x, y" })).toEqual(["x", "y"]);
  });
});
