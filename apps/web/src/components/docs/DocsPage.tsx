import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { SearchIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";

import { useProject, useProjects } from "~/state/entities";
import { SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useStableCallback } from "~/hooks/useStableCallback";
import { DocsPageProvider, type DocsPageControls } from "./docsPageContext";
import { docsProjectRefs } from "./docsProjects";
import { DocsNote } from "./DocsNote";
import { DocsTree } from "./DocsTree";

export interface DocsPageProps {
  /** Vault-relative path of the open note, from the `note` search param. */
  readonly note: string | null;
  readonly onNoteChange: (note: string | null) => void;
  /** Right column; rendered inside `<aside aria-label="Note details">`. Reads controls via a hook. */
  readonly sidePanel?: ReactNode | undefined;
  /** Left column, above the tree; the search button and Ctrl/Cmd+Shift+F appear only when provided. */
  readonly searchPanel?: ReactNode | undefined;
  /** Extra remark plugins for the note renderer. */
  readonly remarkPlugins?: PluggableList | undefined;
  /** Element overrides for the note renderer. */
  readonly components?: Components | undefined;
}

interface History {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
}

export function DocsPage(props: DocsPageProps) {
  const projects = useProjects();
  const refs = docsProjectRefs(projects);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const active = refs.find((ref) => scopedProjectKey(ref) === selectedKey) ?? refs[0] ?? null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {active ? (
        <DocsWorkspace
          key={scopedProjectKey(active)}
          {...props}
          projectRef={active}
          refs={refs}
          titles={
            new Map(
              projects.map((project) => [
                scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
                project.title,
              ]),
            )
          }
          onSelectProject={(ref) => setSelectedKey(scopedProjectKey(ref))}
        />
      ) : (
        <p className="p-6 text-muted-foreground text-sm">
          No docs project. Link one from a project's settings to browse its vault here.
        </p>
      )}
    </SidebarInset>
  );
}

function DocsWorkspace({
  note,
  onNoteChange,
  sidePanel,
  searchPanel,
  remarkPlugins,
  components,
  projectRef,
  refs,
  titles,
  onSelectProject,
}: DocsPageProps & {
  readonly projectRef: ScopedProjectRef;
  readonly refs: ReadonlyArray<ScopedProjectRef>;
  readonly titles: ReadonlyMap<string, string>;
  readonly onSelectProject: (ref: ScopedProjectRef) => void;
}) {
  const project = useProject(projectRef);
  const cwd = project?.workspaceRoot ?? null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [history, setHistory] = useState<History>(() =>
    note ? { entries: [note], index: 0 } : { entries: [], index: -1 },
  );
  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.entries.length - 1;

  const openNote = useStableCallback((path: string, _line?: number) => {
    // ponytail: line is accepted for search results but not scrolled to yet (V3).
    if (path === note) return;
    setHistory((previous) => ({
      entries: [...previous.entries.slice(0, previous.index + 1), path],
      index: previous.index + 1,
    }));
    onNoteChange(path);
  });
  const step = useStableCallback((delta: -1 | 1) => {
    const next = history.index + delta;
    const target = history.entries[next];
    if (target === undefined) return;
    setHistory({ entries: history.entries, index: next });
    onNoteChange(target);
  });
  const toggleSearch = useStableCallback(() => {
    if (searchPanel !== undefined) setSearchOpen((open) => !open);
  });
  const closeSearch = useStableCallback(() => setSearchOpen(false));

  // Keyboard shortcuts exist only while this page is mounted, so preventDefault never reaches other pages.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window key listener scoped to the docs page, which DOM handlers on the root cannot cover when focus is outside it
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modified = event.ctrlKey || event.metaKey;
      if (
        modified &&
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        searchPanel !== undefined
      ) {
        event.preventDefault();
        toggleSearch();
        return;
      }
      if (event.altKey && !modified && !event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.altKey && !modified && !event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchPanel, step, toggleSearch]);

  const controls: DocsPageControls = { openNote, closeSearch };

  return (
    <DocsPageProvider value={controls}>
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h1 className="font-medium text-sm">Docs</h1>
        {refs.length > 1 ? (
          <Select
            value={scopedProjectKey(projectRef)}
            onValueChange={(value) => {
              const ref = refs.find((item) => scopedProjectKey(item) === value);
              if (ref) onSelectProject(ref);
            }}
          >
            <SelectTrigger aria-label="Docs project" size="xs">
              <SelectValue>{project?.title ?? "Docs project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {refs.map((ref) => (
                <SelectItem key={scopedProjectKey(ref)} value={scopedProjectKey(ref)}>
                  {titles.get(scopedProjectKey(ref)) ?? ref.projectId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          {searchPanel !== undefined ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Search vault"
              aria-pressed={searchOpen}
              title="Search (Ctrl/Cmd+Shift+F)"
              onClick={toggleSearch}
            >
              <SearchIcon />
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Vault"
          className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r p-2"
        >
          {searchOpen && searchPanel !== undefined ? searchPanel : null}
          {cwd === null ? (
            <p className="px-2 text-muted-foreground text-xs">Docs project is unavailable.</p>
          ) : (
            <DocsTree
              environmentId={projectRef.environmentId}
              cwd={cwd}
              selectedPath={note}
              onOpenFile={openNote}
            />
          )}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">
          {cwd === null || note === null ? (
            <p className="p-6 text-muted-foreground text-sm">Select a note to read.</p>
          ) : (
            <DocsNote
              environmentId={projectRef.environmentId}
              cwd={cwd}
              path={note}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onBack={() => step(-1)}
              onForward={() => step(1)}
              onOpenNote={openNote}
              remarkPlugins={remarkPlugins}
              components={components}
            />
          )}
        </main>
        <aside aria-label="Note details" className="w-64 shrink-0 overflow-y-auto border-l p-3">
          {sidePanel}
        </aside>
      </div>
    </DocsPageProvider>
  );
}
