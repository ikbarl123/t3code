import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";

interface TreeContext {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly selectedPath: string | null;
  readonly onOpenFile: (path: string) => void;
}

const HIDDEN_FOLDER_NAMES = new Set(["node_modules"]);

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isAncestorOf = (folderPath: string, path: string | null) =>
  path !== null && path.startsWith(`${folderPath}/`);

/** Direct children of `directoryPath` that the vault tree shows: markdown files and folders. */
function visibleChildren(entries: ReadonlyArray<ProjectEntry>, directoryPath: string) {
  return entries
    .filter((entry) => {
      const name = nameOf(entry.path);
      if (parentOf(entry.path) !== directoryPath || name.startsWith(".")) return false;
      if (entry.kind === "directory") return !HIDDEN_FOLDER_NAMES.has(name);
      return /\.md$/i.test(name);
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return nameOf(a.path).localeCompare(nameOf(b.path));
    });
}

function listEntriesAtom(environmentId: EnvironmentId, cwd: string, directoryPath?: string) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, directoryPath: directoryPath ?? "" },
  });
}

export interface DocsTreeProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly selectedPath: string | null;
  readonly onOpenFile: (path: string) => void;
}

/** Vault folder tree. Folders list their children lazily, only once expanded. */
export function DocsTree(props: DocsTreeProps) {
  return <TreeLevel {...props} directoryPath={undefined} depth={0} />;
}

function TreeLevel({
  directoryPath,
  depth,
  ...context
}: DocsTreeProps & { readonly directoryPath: string | undefined; readonly depth: number }) {
  const result = useAtomValue(listEntriesAtom(context.environmentId, context.cwd, directoryPath));
  const listing = AsyncResult.getOrElse(result, () => null);
  const role = depth === 0 ? "tree" : "group";
  if (AsyncResult.isFailure(result)) {
    return (
      <p role="alert" className="px-3 py-2 text-muted-foreground text-xs">
        Could not list {directoryPath ?? "the vault"}.
      </p>
    );
  }
  if (!listing) {
    return <p className="px-3 py-2 text-muted-foreground text-xs">Loading…</p>;
  }
  const children = visibleChildren(listing.entries, directoryPath ?? "");
  return (
    <ul role={role} aria-label={depth === 0 ? "Vault files" : undefined} className="flex flex-col">
      {children.map((entry, index) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          context={context}
          // ponytail: roving tabindex is simplified to "first root item tabbable"; arrow keys move focus.
          tabbable={depth === 0 && index === 0}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  context,
  tabbable,
}: {
  readonly entry: ProjectEntry;
  readonly depth: number;
  readonly context: TreeContext;
  readonly tabbable: boolean;
}) {
  const isFolder = entry.kind === "directory";
  // Expanded by default along the selected note's path; a manual toggle overrides that.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = isFolder && (toggled ?? isAncestorOf(entry.path, context.selectedPath));
  const selected = !isFolder && entry.path === context.selectedPath;

  const activate = () => {
    if (isFolder) setToggled(!expanded);
    else context.onOpenFile(entry.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    // Keys from a nested treeitem bubble here; only handle the ones this row owns.
    if (event.target !== event.currentTarget) return;
    const item = event.currentTarget;
    const items = Array.from(
      item
        .closest<HTMLElement>('[role="tree"]')
        ?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );
    const index = items.indexOf(item);
    const focusAt = (next: number | undefined) => items[next ?? -1]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "ArrowRight":
        if (isFolder && !expanded) setToggled(true);
        else focusAt(index + 1);
        break;
      case "ArrowLeft":
        if (isFolder && expanded) setToggled(false);
        else item.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
        break;
      case "Enter":
      case " ":
        activate();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-path={entry.path}
      onKeyDown={handleKeyDown}
      className="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div
        onClick={activate}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-sm hover:bg-accent",
          selected && "bg-accent text-foreground",
          !selected && "text-muted-foreground",
        )}
      >
        {isFolder ? (
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          />
        ) : (
          <span aria-hidden className="w-3.5 shrink-0" />
        )}
        {isFolder ? (
          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{nameOf(entry.path)}</span>
      </div>
      {isFolder && expanded ? (
        <TreeLevel
          environmentId={context.environmentId}
          cwd={context.cwd}
          selectedPath={context.selectedPath}
          onOpenFile={context.onOpenFile}
          directoryPath={entry.path}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}
