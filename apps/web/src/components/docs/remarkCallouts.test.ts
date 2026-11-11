import type { Root } from "mdast";
import { describe, expect, it } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { remarkCallouts } from "./remarkCallouts";

const run = (md: string) => {
  const tree = fromMarkdown(md) as Root;
  remarkCallouts()(tree);
  return tree.children[0] as {
    type: string;
    data?: { hProperties: Record<string, unknown> };
    children: unknown[];
  };
};

describe("remarkCallouts", () => {
  it("reads type and title from an Obsidian callout", () => {
    const bq = run("> [!warning] Careful\n> body text");
    expect(bq.type).toBe("blockquote");
    expect(bq.data?.hProperties).toMatchObject({
      "data-callout": "warning",
      "data-callout-title": "Careful",
    });
    expect(bq.children).toHaveLength(1);
  });

  it("defaults the title to the capitalized type and keeps fold marker", () => {
    const bq = run("> [!Tip]-\n> hi");
    expect(bq.data?.hProperties).toMatchObject({
      "data-callout": "tip",
      "data-callout-title": "Tip",
      "data-callout-fold": "-",
    });
  });

  it("leaves plain blockquotes and GitHub alerts alone", () => {
    expect(run("> plain").data).toBeUndefined();
    expect(run("> [!NOTE]\n> gh").data?.hProperties).toMatchObject({ "data-callout": "note" });
  });
});
