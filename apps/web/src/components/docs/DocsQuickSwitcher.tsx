import { useMemo, useState, type KeyboardEvent } from "react";

import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "../ui/command";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { rankNotePaths } from "./quickSwitch";

export interface DocsQuickSwitcherProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly paths: ReadonlyArray<string>;
  readonly onOpenNote: (path: string) => void;
}

/** Ctrl/Cmd+O note picker: fuzzy filename search over the vault's markdown paths. */
export function DocsQuickSwitcher(props: DocsQuickSwitcherProps) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup aria-label="Quick switcher">
        {props.open ? <QuickSwitcherBody {...props} /> : null}
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function QuickSwitcherBody({ paths, onOpenChange, onOpenNote }: DocsQuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => rankNotePaths(paths, query), [paths, query]);
  const selected = matches[Math.min(active, matches.length - 1)];

  const choose = (path: string | undefined) => {
    if (path === undefined) return;
    onOpenNote(path);
    onOpenChange(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) =>
        matches.length === 0 ? 0 : (index + step + matches.length) % matches.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(selected);
    }
  };

  return (
    <CommandPaletteContent
      aria-label="Open note"
      escapeLabel="Close"
      footerActionLabel="Open note"
      inputProps={{
        placeholder: "Open note…",
        value: query,
        onChange: (event) => {
          setQuery(event.target.value);
          setActive(0);
        },
        onKeyDown,
      }}
      mode="none"
      testId="docs-quick-switcher"
      value=""
    >
      <CommandList>
        {matches.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground text-sm">No matching notes.</p>
        ) : (
          matches.map((path, index) => (
            <CommandItem
              key={path}
              value={path}
              active={path === selected}
              aria-selected={path === selected}
              onClick={() => choose(path)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="truncate">{path}</span>
            </CommandItem>
          ))
        )}
      </CommandList>
    </CommandPaletteContent>
  );
}
