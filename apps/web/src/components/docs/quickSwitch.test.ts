import { describe, expect, it } from "vite-plus/test";

import { rankNotePaths } from "./quickSwitch";

describe("rankNotePaths", () => {
  const paths = ["docs/START.md", "docs/plans/P1.md", "notes/plan-ideas.md", "docs/plans/P10.md"];

  it("returns the paths in order for an empty query", () => {
    expect(rankNotePaths(paths, "  ")).toEqual(paths);
  });

  it("matches subsequences case-insensitively and drops non-matches", () => {
    expect(rankNotePaths(paths, "p1")).toEqual(["docs/plans/P1.md", "docs/plans/P10.md"]);
    expect(rankNotePaths(paths, "zzz")).toEqual([]);
  });

  it("ranks filename hits above folder-only hits", () => {
    expect(rankNotePaths(["plan/x.md", "notes/plan.md"], "plan")).toEqual([
      "notes/plan.md",
      "plan/x.md",
    ]);
  });
});
