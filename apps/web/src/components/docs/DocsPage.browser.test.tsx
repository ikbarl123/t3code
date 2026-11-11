import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DocsPage } from "./DocsPage";

const files: Record<string, string> = {
  "docs/START.md":
    "---\ntitle: Start\ntags: [home]\nstatus: active\n---\n# Start\n\n[Plans](plans/P1.md)\n\nSee [[P1]] and [[Missing Note]].\n\n## Details\n\nNote text.\n\n> [!warning] Careful\n> watch out",
  "docs/plans/P1.md": "# Plan one\n\nBody text. Back to [[START#Details]].",
  "docs/plans/P2.md": "# Plan two\n\nUnrelated.",
};
const directories: Record<string, ReadonlyArray<{ path: string; kind: "file" | "directory" }>> = {
  "": [
    { path: "docs", kind: "directory" },
    { path: ".obsidian", kind: "directory" },
  ],
  docs: [
    { path: "docs/START.md", kind: "file" },
    { path: "docs/plans", kind: "directory" },
    { path: "docs/notes.txt", kind: "file" },
  ],
  "docs/plans": [
    { path: "docs/plans/P1.md", kind: "file" },
    { path: "docs/plans/P2.md", kind: "file" },
  ],
};

vi.mock("~/state/projects", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const ok = (value: unknown) => Atom.make(AsyncResult.success(value));
  return {
    // Content search is not exercised here; an empty result keeps DocsSearchSlot inert.
    projectContentSearch: () => ok({ matches: [], truncated: false }),
    projectEnvironment: {
      listEntries: ({ input }: { input: { directoryPath?: string } }) =>
        ok({ entries: directories[input.directoryPath ?? ""] ?? [], truncated: false }),
      readFile: ({ input }: { input: { relativePath: string } }) => {
        const contents = files[input.relativePath];
        return ok({
          relativePath: input.relativePath,
          contents: contents ?? "",
          byteLength: contents?.length ?? 0,
          truncated: false,
          exists: contents !== undefined,
        });
      },
    },
  };
});

// Image embeds read asset URLs; the real hook reaches the connection runtime, which tests do not run.
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Loading" }),
}));

// The code project links to a docs project; DocsPage resolves the vault from that link.
vi.mock("~/state/entities", () => {
  const vault = { id: "docs", environmentId: "env-1", title: "Vault", workspaceRoot: "/vault" };
  const code = {
    id: "code",
    environmentId: "env-1",
    title: "Code",
    workspaceRoot: "/code",
    docsProjectId: "docs",
  };
  return {
    useProjects: () => [code],
    useProject: () => vault,
  };
});

it("renders the vault tree and the note with frontmatter stripped", async () => {
  await using screen = await render(<DocsPage note="docs/START.md" onNoteChange={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Start" })).toBeInTheDocument();
  await expect.element(screen.getByRole("treeitem", { name: "START.md" })).toBeInTheDocument();
  await expect.element(screen.getByRole("treeitem", { name: "docs" })).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("title: Start");
  expect(screen.container.textContent).not.toContain(".obsidian");
  expect(screen.container.textContent).not.toContain("notes.txt");
});

it("expands a folder with aria-expanded and opens a note on click", async () => {
  const onNoteChange = vi.fn();
  await using screen = await render(<DocsPage note={null} onNoteChange={onNoteChange} />);
  const docs = screen.getByRole("treeitem", { name: "docs" });
  await expect.element(docs).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(docs.element() as HTMLElement);
  await expect.element(docs).toHaveAttribute("aria-expanded", "true");
  const plans = screen.getByRole("treeitem", { name: "plans" });
  await expect.element(plans).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(plans.element() as HTMLElement);
  await userEvent.click(screen.getByText("P1.md").element() as HTMLElement);
  expect(onNoteChange).toHaveBeenCalledWith("docs/plans/P1.md");
});

it("follows a relative markdown link inside the vault", async () => {
  const onNoteChange = vi.fn();
  await using screen = await render(<DocsPage note="docs/START.md" onNoteChange={onNoteChange} />);
  await userEvent.click(screen.getByRole("link", { name: "Plans" }).element() as HTMLElement);
  expect(onNoteChange).toHaveBeenLastCalledWith("docs/plans/P1.md");
});

it("navigates a wikilink to an existing note and styles a missing one as not created", async () => {
  const onNoteChange = vi.fn();
  await using screen = await render(<DocsPage note="docs/START.md" onNoteChange={onNoteChange} />);
  await userEvent.click(screen.getByRole("link", { name: "P1" }).element() as HTMLElement);
  expect(onNoteChange).toHaveBeenLastCalledWith("docs/plans/P1.md");
  await expect
    .element(screen.getByText("Missing Note"))
    .toHaveAttribute("title", "Not created yet");
});

it("lists backlinks grouped by source note and opens the source on click", async () => {
  const onNoteChange = vi.fn();
  await using screen = await render(
    <DocsPage note="docs/plans/P1.md" onNoteChange={onNoteChange} />,
  );
  // START links to P1 with [[P1]], so P1's backlinks show START with the source line.
  const aside = screen.container.querySelector<HTMLElement>("aside[aria-label='Note details']");
  const source = aside?.querySelector<HTMLElement>("button[class*='font-medium']");
  expect(source?.textContent).toBe("docs/START.md");
  await userEvent.click(source as HTMLElement);
  expect(onNoteChange).toHaveBeenLastCalledWith("docs/START.md");
});

it("opens the quick switcher with Ctrl+O and opens the selected note", async () => {
  const onNoteChange = vi.fn();
  await using screen = await render(<DocsPage note={null} onNoteChange={onNoteChange} />);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true }));
  await expect.element(screen.getByPlaceholder("Open note…")).toBeInTheDocument();
  await userEvent.keyboard("p2");
  await userEvent.keyboard("{Enter}");
  expect(onNoteChange).toHaveBeenLastCalledWith("docs/plans/P2.md");
});

it("opens the vault search panel with Ctrl+Shift+F", async () => {
  await using screen = await render(<DocsPage note={null} onNoteChange={() => {}} />);
  expect(screen.container.querySelector("[aria-label='Search vault contents']")).toBeNull();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "F", ctrlKey: true, shiftKey: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Search vault contents" }))
    .toBeInTheDocument();
});
