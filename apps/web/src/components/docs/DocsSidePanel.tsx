import { useMemo } from "react";

import { Badge } from "../ui/badge";
import { splitFrontmatter, type FrontmatterValue } from "./frontmatter";
import { outlineWithLines, type Backlink } from "./backlinks";
import { useDocsPage } from "./docsPageContext";
import { extractTags } from "./tags";

/** Note details for the open note: properties, tags, outline, backlinks and outgoing links. */
export function DocsSidePanel() {
  const { activePath, activeText, vault, openNote } = useDocsPage();
  if (activePath === null) {
    return <p className="text-muted-foreground text-sm">Open a note to see its details.</p>;
  }
  if (activeText === null) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  return <NoteDetails path={activePath} text={activeText} vault={vault} openNote={openNote} />;
}

type NoteDetailsProps = Pick<ReturnType<typeof useDocsPage>, "vault" | "openNote"> & {
  readonly path: string;
  readonly text: string;
};

function NoteDetails({ path, text, vault, openNote }: NoteDetailsProps) {
  const { properties, body } = useMemo(() => splitFrontmatter(text), [text]);
  const tags = useMemo(() => extractTags(body, properties), [body, properties]);
  const headings = useMemo(() => outlineWithLines(body), [body]);
  const backlinks = vault.index?.backlinks.get(path) ?? [];
  const outgoing = vault.index?.outgoing.get(path) ?? [];
  const propertyEntries = Object.entries(properties);

  return (
    <div className="flex flex-col gap-4 text-sm">
      {propertyEntries.length > 0 ? (
        <Section title="Properties">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {propertyEntries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words">
                  <PropertyValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
      {tags.length > 0 ? (
        <Section title="Tags">
          <ul className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <li key={tag}>
                <Badge variant="outline">#{tag}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {headings.length > 0 ? (
        <Section title="Outline">
          <ul className="flex flex-col">
            {headings.map((heading) => (
              <li
                key={`${heading.line}`}
                style={{ paddingInlineStart: `${(heading.level - 1) * 0.75}rem` }}
              >
                <button
                  type="button"
                  className="max-w-full truncate py-0.5 text-start text-primary hover:underline"
                  onClick={() => openNote(path, { heading: heading.slug })}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Backlinks">
        {vault.status === "indexing" || vault.status === "loading" ? (
          <p className="text-muted-foreground text-xs">Indexing vault…</p>
        ) : backlinks.length === 0 ? (
          <p className="text-muted-foreground text-xs">No notes link here.</p>
        ) : (
          <BacklinkGroups backlinks={backlinks} openNote={openNote} />
        )}
      </Section>
      <Section title="Outgoing links">
        {outgoing.length === 0 ? (
          <p className="text-muted-foreground text-xs">No links from this note.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {outgoing.map((target) => (
              <li key={target}>
                <button
                  type="button"
                  className="max-w-full truncate text-start text-primary hover:underline"
                  onClick={() => openNote(target)}
                >
                  {target}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function BacklinkGroups({
  backlinks,
  openNote,
}: {
  readonly backlinks: ReadonlyArray<Backlink>;
  readonly openNote: (path: string, target?: { line?: number }) => void;
}) {
  const groups = useMemo(() => {
    const byFrom = new Map<string, Backlink[]>();
    for (const link of backlinks) {
      const list = byFrom.get(link.from) ?? [];
      list.push(link);
      byFrom.set(link.from, list);
    }
    return [...byFrom];
  }, [backlinks]);
  return (
    <ul className="flex flex-col gap-3">
      {groups.map(([from, links]) => (
        <li key={from}>
          <button
            type="button"
            className="max-w-full truncate font-medium text-primary hover:underline"
            onClick={() => openNote(from)}
          >
            {from}
          </button>
          <ul className="mt-1 flex flex-col gap-1">
            {links.map((link) => (
              <li key={`${link.from}:${link.line}`}>
                <button
                  type="button"
                  className="w-full truncate rounded-sm px-1 py-0.5 text-start text-muted-foreground text-xs hover:bg-accent"
                  onClick={() => openNote(link.from, { line: link.line })}
                >
                  <span className="mr-1 font-mono">L{link.line}</span>
                  {link.context}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function PropertyValue({ value }: { readonly value: FrontmatterValue }) {
  if (Array.isArray(value)) {
    return (
      <ul className="flex flex-wrap gap-1">
        {value.map((item) => (
          <li key={item}>
            <Badge variant="secondary">{item}</Badge>
          </li>
        ))}
      </ul>
    );
  }
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <>{String(value)}</>;
}
