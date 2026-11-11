import { EnvironmentId, type ProjectSearchContentsResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DocsSearchPanel } from "./DocsSearchPanel";

const environmentId = EnvironmentId.make("local");

// Stub the RPC atom family: results are a pure function of the request, so memoizing by input is safe.
vi.mock("~/state/projects", async (original) => {
  const searchAtoms = Atom.family((key: string) => {
    const { input } = JSON.parse(key) as { input: { query: string; useRegex: boolean } };
    const result: ProjectSearchContentsResult =
      input.useRegex && input.query === "("
        ? { matches: [], truncated: false, regexFallbackError: "Unterminated group" }
        : {
            matches: [
              {
                path: "notes/a.md",
                lineNumber: 2,
                lineContent: "a shared needle here",
                matchRanges: [{ start: 9, end: 15 }],
              },
              {
                path: "notes/a.md",
                lineNumber: 7,
                lineContent: "needle again",
                matchRanges: [{ start: 0, end: 6 }],
              },
              {
                path: "b.md",
                lineNumber: 1,
                lineContent: "needle",
                matchRanges: [{ start: 0, end: 6 }],
              },
            ],
            truncated: false,
          };
    return Atom.make(AsyncResult.success(result));
  });
  return {
    ...(await original<typeof import("~/state/projects")>()),
    projectContentSearch: (request: { environmentId: string; input: unknown }) =>
      searchAtoms(JSON.stringify(request)),
  };
});

it("renders results grouped by file with highlighted ranges and a summary", async () => {
  await using screen = await render(
    <DocsSearchPanel
      environmentId={environmentId}
      docsRoot="/vault"
      onOpenNote={() => {}}
      onClose={() => {}}
    />,
  );
  await page.getByRole("textbox", { name: "Search vault contents" }).fill("needle");
  await expect.element(screen.getByText("3 results in 2 files")).toBeInTheDocument();
  await expect.element(screen.getByText("notes/a.md")).toBeInTheDocument();
  await expect.element(screen.getByText("needle", { exact: true }).first()).toBeInTheDocument();
  expect(document.querySelectorAll("mark")).toHaveLength(3);
});

it("opens the note at the match line on click", async () => {
  const onOpenNote = vi.fn();
  await using _screen = await render(
    <DocsSearchPanel
      environmentId={environmentId}
      docsRoot="/vault"
      onOpenNote={onOpenNote}
      onClose={() => {}}
    />,
  );
  await page.getByRole("textbox", { name: "Search vault contents" }).fill("needle");
  await expect.element(page.getByRole("button", { name: /needle again/ })).toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: /needle again/ }));
  expect(onOpenNote).toHaveBeenCalledExactlyOnceWith("notes/a.md", 7);
});

it("flips aria-pressed on the option toggles", async () => {
  await using _screen = await render(
    <DocsSearchPanel
      environmentId={environmentId}
      docsRoot="/vault"
      onOpenNote={() => {}}
      onClose={() => {}}
    />,
  );
  const wholeWord = page.getByRole("button", { name: "Match Whole Word" });
  await expect.element(wholeWord).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(wholeWord);
  await expect.element(wholeWord).toHaveAttribute("aria-pressed", "true");
});

it("shows Invalid regex when the server reports a regex fallback error", async () => {
  await using _screen = await render(
    <DocsSearchPanel
      environmentId={environmentId}
      docsRoot="/vault"
      onOpenNote={() => {}}
      onClose={() => {}}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Use Regular Expression" }));
  await page.getByRole("textbox", { name: "Search vault contents" }).fill("(");
  await expect.element(page.getByText("Invalid regex")).toBeInTheDocument();
});
