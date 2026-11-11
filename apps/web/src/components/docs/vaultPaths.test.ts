import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectMarkdownPaths, mapConcurrent } from "./vaultPaths";

const dir = (path: string): ProjectEntry => ({ path, kind: "directory" });
const file = (path: string): ProjectEntry => ({ path, kind: "file" });

function fakeVault(tree: Record<string, ProjectEntry[]>) {
  return async (directory: string | undefined) => {
    const entries = tree[directory ?? ""];
    if (entries === undefined) throw new Error(`no ${directory}`);
    return entries;
  };
}

describe("collectMarkdownPaths", () => {
  it("walks folders and keeps only markdown files, skipping dot entries and node_modules", async () => {
    const list = fakeVault({
      "": [dir("docs"), dir(".obsidian"), dir("node_modules"), file("README.md"), file("a.txt")],
      docs: [file("docs/START.md"), file("docs/x.MD"), file(".hidden.md")],
      ".obsidian": [file(".obsidian/app.md")],
      node_modules: [file("node_modules/pkg.md")],
    });
    expect(await collectMarkdownPaths(list)).toEqual(["README.md", "docs/START.md", "docs/x.MD"]);
  });

  it("keeps only direct children of each listed folder", async () => {
    // The root listing can include indexed descendants; they must not be re-added by the walk.
    const list = fakeVault({
      "": [dir("docs"), file("README.md"), file("docs/START.md")],
      docs: [file("docs/START.md")],
    });
    expect(await collectMarkdownPaths(list)).toEqual(["README.md", "docs/START.md"]);
  });

  it("stops at the limit", async () => {
    const list = fakeVault({ "": [file("a.md"), file("b.md"), file("c.md")] });
    expect(await collectMarkdownPaths(list, 2)).toEqual(["a.md", "b.md"]);
  });

  it("throws when the root cannot be listed but skips a failing subfolder", async () => {
    const list = fakeVault({ "": [dir("broken"), file("ok.md")] });
    expect(await collectMarkdownPaths(list)).toEqual(["ok.md"]);
    await expect(collectMarkdownPaths(() => Promise.reject(new Error("denied")))).rejects.toThrow(
      "denied",
    );
  });
});

describe("mapConcurrent", () => {
  it("keeps input order and never exceeds the concurrency bound", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
