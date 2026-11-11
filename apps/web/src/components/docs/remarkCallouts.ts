import type { Blockquote, Parent, Root } from "mdast";

// Matches Obsidian `[!type]+/- Title`. Runs alongside remarkGithubAlerts (packages/shared), which owns the bare GitHub set.
const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)(\n|$)/;

export function remarkCallouts() {
  const visit = (parent: Parent) => {
    for (const node of parent.children) {
      if ("children" in node) visit(node as Parent);
      if (node.type === "blockquote") readCallout(node);
    }
  };
  return (tree: Root) => {
    visit(tree);
  };
}

function readCallout(bq: Blockquote): void {
  const paragraph = bq.children[0];
  const text = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  if (!paragraph || paragraph.type !== "paragraph" || text?.type !== "text") return;
  const match = CALLOUT.exec(text.value);
  if (!match) return;
  const [whole, rawType = "", fold, rawTitle = "", newline] = match;
  if (!newline && paragraph.children.length > 1) return;

  const rest = text.value.slice(whole.length);
  if (rest) {
    text.value = rest;
  } else {
    paragraph.children.shift();
    if (paragraph.children.length === 0) bq.children.shift();
  }

  const type = rawType.toLowerCase();
  const title = rawTitle.trim() || type.charAt(0).toUpperCase() + type.slice(1);
  bq.data = {
    ...bq.data,
    hProperties: {
      ...bq.data?.hProperties,
      "data-callout": type,
      "data-callout-title": title,
      ...(fold ? { "data-callout-fold": fold } : {}),
    },
  };
}
