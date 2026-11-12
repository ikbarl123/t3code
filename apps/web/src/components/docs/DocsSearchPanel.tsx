import type { EnvironmentId, ProjectContentMatch } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { projectContentSearch } from "~/state/projects";
import { useDebouncedValue } from "~/state/queries";

import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 500;
const QUERY_MAX_LENGTH = 256;

interface DocsSearchPanelProps {
  readonly environmentId: EnvironmentId;
  readonly docsRoot: string;
  readonly onOpenNote: (path: string, line?: number) => void;
  readonly onClose: () => void;
  readonly autoFocus?: boolean;
}

interface IndexedMatch {
  readonly match: ProjectContentMatch;
  readonly index: number;
}

interface MatchGroup {
  readonly path: string;
  readonly matches: ReadonlyArray<IndexedMatch>;
}

const NO_MATCHES: ReadonlyArray<ProjectContentMatch> = [];

/** Obsidian's .obsidian/ and other dot directories are noise; dotfiles themselves are still shown. */
function isInHiddenDirectory(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.startsWith("."));
}

function groupVisibleMatches(
  matches: ReadonlyArray<ProjectContentMatch>,
  collapsed: ReadonlySet<string>,
): { readonly groups: MatchGroup[]; readonly rows: ReadonlyArray<IndexedMatch> } {
  const byPath = new Map<string, IndexedMatch[]>();
  const rows: IndexedMatch[] = [];
  for (const match of matches) {
    if (isInHiddenDirectory(match.path)) continue;
    const isCollapsed = collapsed.has(match.path);
    const indexed = { match, index: isCollapsed ? -1 : rows.length };
    if (!isCollapsed) rows.push(indexed);
    const group = byPath.get(match.path);
    if (group) group.push(indexed);
    else byPath.set(match.path, [indexed]);
  }
  const groups = [...byPath].map(([path, groupMatches]) => ({ path, matches: groupMatches }));
  return { groups, rows };
}

/** Ranges are string offsets into lineContent; clamp, sort and merge before slicing. */
function renderHighlightedLine(match: ProjectContentMatch): ReactNode {
  const { lineContent } = match;
  const ranges = match.matchRanges
    .map((range) => ({
      start: Math.max(0, Math.min(lineContent.length, range.start)),
      end: Math.max(0, Math.min(lineContent.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push(lineContent.slice(cursor, range.start));
    parts.push(
      <mark key={range.start} className="rounded-sm bg-primary/25 text-foreground">
        {lineContent.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < lineContent.length) parts.push(lineContent.slice(cursor));
  return parts;
}

function OptionToggle(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.pressed}
            size="segmented"
            variant="segmented"
            onPressedChange={props.onPressedChange}
          />
        }
      >
        <span className="font-mono">{props.children}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function DocsSearchPanel({
  environmentId,
  docsRoot,
  onOpenNote,
  onClose,
  autoFocus = false,
}: DocsSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  // Whitespace is significant in content queries, so only the emptiness check trims.
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  const cwd = docsRoot.trim();
  const shouldSearch = cwd.length > 0 && debouncedQuery.trim().length > 0;
  const result = useEnvironmentQuery(
    shouldSearch
      ? projectContentSearch({
          environmentId,
          input: {
            cwd,
            query: debouncedQuery,
            limit: SEARCH_LIMIT,
            caseSensitive,
            wholeWord,
            useRegex,
          },
        })
      : null,
  );

  const rawMatches = result.data?.matches ?? NO_MATCHES;
  const { groups, rows } = groupVisibleMatches(rawMatches, collapsed);
  const fileCount = groups.length;
  const visibleCount = groups.reduce((total, group) => total + group.matches.length, 0);
  const isStale = query !== debouncedQuery || result.isPending;
  const hasQuery = query.trim().length > 0;

  // Selection is per result set; reset when a new search lands (same pattern as ProjectContentSearchDialog).
  const [resultsFor, setResultsFor] = useState(rawMatches);
  if (resultsFor !== rawMatches) {
    setResultsFor(rawMatches);
    setSelectedIndex(0);
  }
  const activeIndex = rows.length === 0 ? -1 : Math.min(selectedIndex, rows.length - 1);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the keyboard-selected row visible in the scroll container
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const openRow = (row: IndexedMatch | undefined) => {
    if (row) onOpenNote(row.match.path, row.match.lineNumber);
  };

  const toggleGroup = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex(Math.min(activeIndex + 1, rows.length - 1));
    } else if (event.key === "ArrowUp" && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      openRow(rows[activeIndex]);
    }
  };

  let status: ReactNode = null;
  if (!hasQuery) {
    status = (
      <p className="px-3 py-6 text-center text-muted-foreground text-sm">
        Type to search the vault.
      </p>
    );
  } else if (result.error !== null && !isStale) {
    status = (
      <p role="alert" className="px-3 py-2 text-destructive text-sm">
        {result.error}
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-1">
        <Input
          aria-label="Search vault contents"
          autoFocus={autoFocus}
          maxLength={QUERY_MAX_LENGTH}
          placeholder="Search vault…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <OptionToggle label="Match Case" pressed={caseSensitive} onPressedChange={setCaseSensitive}>
          Aa
        </OptionToggle>
        <OptionToggle label="Match Whole Word" pressed={wholeWord} onPressedChange={setWholeWord}>
          ab
        </OptionToggle>
        <OptionToggle
          label="Use Regular Expression"
          pressed={useRegex}
          onPressedChange={setUseRegex}
        >
          .*
        </OptionToggle>
      </div>

      {hasQuery && !isStale && result.data?.regexFallbackError !== undefined ? (
        <p
          role="alert"
          className="px-1 text-destructive text-sm"
          title={result.data.regexFallbackError}
        >
          Invalid regex
        </p>
      ) : null}

      {hasQuery && !isStale && result.data ? (
        <p className="px-1 text-muted-foreground text-xs" aria-live="polite">
          {visibleCount} {visibleCount === 1 ? "result" : "results"} in {fileCount}{" "}
          {fileCount === 1 ? "file" : "files"}
          {result.data.truncated ? ` · Showing first ${visibleCount} results` : null}
        </p>
      ) : null}
      {hasQuery && isStale ? (
        <p className="px-1 text-muted-foreground text-xs" aria-live="polite">
          Searching…
        </p>
      ) : null}

      {status}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.path);
          return (
            <section key={group.path} className="pb-1">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-sm hover:bg-accent"
                onClick={() => toggleGroup(group.path)}
              >
                <ChevronRightIcon
                  aria-hidden
                  className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{group.path}</span>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {group.matches.length}
                </span>
              </button>
              {isCollapsed
                ? null
                : group.matches.map(({ match, index }) => {
                    const selected = index === activeIndex;
                    return (
                      <button
                        key={`${match.path}:${match.lineNumber}:${index}`}
                        ref={selected ? selectedRowRef : undefined}
                        type="button"
                        data-selected={selected ? "" : undefined}
                        className="flex w-full items-baseline gap-2 rounded-md py-0.5 pr-2 pl-6 text-left font-mono text-xs hover:bg-accent data-selected:bg-accent"
                        onClick={() => openRow({ match, index })}
                      >
                        <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                          {match.lineNumber}
                        </span>
                        <span className="min-w-0 truncate whitespace-pre">
                          {renderHighlightedLine(match)}
                        </span>
                      </button>
                    );
                  })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
