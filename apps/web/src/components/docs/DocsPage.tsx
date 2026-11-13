import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
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
import {
  DocsPageProvider,
  type DocsPageControls,
  type NoteStatus,
  type NoteTarget,
} from "./docsPageContext";
import { docsProjectRefs } from "./docsProjects";
import { DocsNote } from "./DocsNote";
import { DocsQuickSwitcher } from "./DocsQuickSwitcher";
import { DocsSearchSlot } from "./DocsSearchSlot";
import { DocsSidePanel } from "./DocsSidePanel";
import { DocsTree } from "./DocsTree";
import { noteTextAtom } from "./noteText";
import { useVaultIndex } from "./useVaultIndex";

export interface DocsPageProps {
  /** Vault-relative path of the open note, from the `note` search param. */
  readonly note: string | null;
  readonly onNoteChange: (note: string | null) => void;
  /** Right column override; defaults to the note details panel. Reads controls via a hook. */
  readonly sidePanel?: ReactNode | undefined;
  /** Left column override, above the tree; defaults to the vault content search. */
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
          onSelectProject={(ref) => {
            setSelectedKey(scopedProjectKey(ref));
            // The note belongs to the old vault; the remounted workspace starts with empty history.
            props.onNoteChange(null);
          }}
        />
      ) : (
        <p className="p-6 text-muted-foreground text-sm">
          No docs project. Link one from a project's settings to browse its vault here.
        </p>
      )}
    </SidebarInset>
  );
}

/** Note text and read state for the side panel and context. Text is null unless status is `ready`. */
function useActiveNote(
  projectRef: ScopedProjectRef,
  cwd: string | null,
  note: string | null,
): { readonly text: string | null; readonly status: NoteStatus } {
  const noteResult = useAtomValue(noteTextAtom(projectRef.environmentId, cwd, note));
  if (note === null || cwd === null) return { text: null, status: "loading" };
  if (AsyncResult.isFailure(noteResult)) return { text: null, status: "error" };
  if (!AsyncResult.isSuccess(noteResult)) return { text: null, status: "loading" };
  if (noteResult.value.exists === false) return { text: null, status: "missing" };
  return { text: noteResult.value.contents, status: "ready" };
}

/** Re-reads the open note from disk; a no-op until a note and vault are both known. */
function useActiveNoteRefresh(
  projectRef: ScopedProjectRef,
  cwd: string | null,
  note: string | null,
): () => void {
  const refresh = useAtomRefresh(noteTextAtom(projectRef.environmentId, cwd, note));
  return () => {
    if (note !== null && cwd !== null) refresh();
  };
}

/** Pushes a note that is not already the current entry; the back/forward step moves the index itself. */
function pushVisit(history: History, path: string): History {
  if (history.entries[history.index] === path) return history;
  return {
    entries: [...history.entries.slice(0, history.index + 1), path],
    index: history.index + 1,
  };
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
  const vault = useVaultIndex(projectRef.environmentId, cwd);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [target, setTarget] = useState<NoteTarget | null>(null);
  const [history, setHistory] = useState<History>(() =>
    note ? { entries: [note], index: 0 } : { entries: [], index: -1 },
  );
  // Any note change not made by step() (a link, the quick switcher, a pasted URL) becomes a new visit.
  const [seenNote, setSeenNote] = useState(note);
  if (note !== seenNote) {
    setSeenNote(note);
    if (note !== null) setHistory((previous) => pushVisit(previous, note));
  }
  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.entries.length - 1;

  const openNote = useStableCallback((path: string, next?: NoteTarget) => {
    setTarget(next ?? null);
    if (path !== note) onNoteChange(path);
  });
  const step = useStableCallback((delta: -1 | 1) => {
    const next = history.index + delta;
    const targetPath = history.entries[next];
    if (targetPath === undefined) return;
    setHistory({ entries: history.entries, index: next });
    setTarget(null);
    onNoteChange(targetPath);
  });
  const toggleSearch = useStableCallback(() => {
    setSearchOpen((open) => !open);
  });
  const closeSearch = useStableCallback(() => setSearchOpen(false));

  // The note is read once here; DocsNote and the side panel both read the same cached atom.
  const { text: activeText, status: noteStatus } = useActiveNote(projectRef, cwd, note);
  const refreshNote = useActiveNoteRefresh(projectRef, cwd, note);
  // useVaultIndex already reloads the vault on focus; the open note is re-read here.
  const refreshNoteOnFocus = useStableCallback(() => refreshNote());
  const refreshAll = useStableCallback(() => {
    vault.refresh();
    refreshNote();
  });
  useEffect(() => {
    window.addEventListener("focus", refreshNoteOnFocus);
    return () => window.removeEventListener("focus", refreshNoteOnFocus);
  }, [refreshNoteOnFocus]);

  // Keyboard shortcuts exist only while this page is mounted, so preventDefault never reaches other pages.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window key listener scoped to the docs page, which DOM handlers on the root cannot cover when focus is outside it
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modified = event.ctrlKey || event.metaKey;
      if (modified && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleSearch();
        return;
      }
      if (modified && !event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
        return;
      }
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (editing) return;
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
  }, [step, toggleSearch]);

  const controls: DocsPageControls = {
    openNote,
    closeSearch,
    activePath: note,
    activeText,
    noteStatus,
    vault: { paths: vault.paths, index: vault.index, status: vault.status },
  };
  const searchSlot =
    searchPanel !== undefined ? (
      searchPanel
    ) : cwd === null ? null : (
      <DocsSearchSlot environmentId={projectRef.environmentId} docsRoot={cwd} />
    );
  const sideSlot = sidePanel !== undefined ? sidePanel : <DocsSidePanel />;

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
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh vault"
            title="Refresh vault"
            disabled={cwd === null}
            onClick={refreshAll}
          >
            <RefreshCwIcon />
          </Button>
          {searchSlot !== null ? (
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
          {searchOpen && searchSlot !== null ? searchSlot : null}
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
              allPaths={vault.paths}
              target={target}
              remarkPlugins={remarkPlugins}
              components={components}
            />
          )}
        </main>
        <aside aria-label="Note details" className="w-64 shrink-0 overflow-y-auto border-l p-3">
          {sideSlot}
        </aside>
      </div>
      <DocsQuickSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        paths={vault.paths}
        onOpenNote={(path) => openNote(path)}
      />
    </DocsPageProvider>
  );
}
