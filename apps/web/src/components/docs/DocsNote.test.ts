import { describe, expect, it } from "vite-plus/test";
import { linkedNotePath } from "./DocsNote";

describe("linkedNotePath", () => {
  it("resolves relative links and decodes each segment", () => {
    expect(linkedNotePath("docs/START.md", "plans/My%20Plan.md#Goals")).toBe(
      "docs/plans/My Plan.md",
    );
    expect(linkedNotePath("docs/a/b.md", "../c%C3%A9.md")).toBe("docs/cé.md");
  });

  it("keeps the raw segment when it is not valid percent-encoding", () => {
    expect(linkedNotePath("docs/START.md", "100%.md")).toBe("docs/100%.md");
  });

  it("ignores external and non-note links", () => {
    expect(linkedNotePath("docs/START.md", "https://x.com/a.md")).toBeNull();
    expect(linkedNotePath("docs/START.md", "image.png")).toBeNull();
  });
});
