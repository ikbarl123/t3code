import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, FileIcon } from "lucide-react";
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { noteTextAtom } from "./noteText";
import { splitFrontmatter } from "./frontmatter";
import { remarkCallouts } from "./remarkCallouts";
import { remarkWikilinks } from "./remarkWikilinks";
import { slugifyHeading } from "./backlinks";
import { rehypeNoteAnchors } from "./docsRehype";
import type { NoteTarget } from "./docsPageContext";

const BASE_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Vault-relative path of a markdown link target, or null for anything that is not a note. */
export function linkedNotePath(notePath: string, href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) {
    return null;
  }
  const [rawTarget] = href.split("#");
  if (!rawTarget || !/\.md$/i.test(rawTarget)) return null;
  const target = rawTarget.split("/").map(decodeSegment).join("/");
  const segments = notePath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

export interface DocsNoteProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onOpenNote: (path: string, target?: NoteTarget) => void;
  /** Every vault note path, used to resolve `[[wikilinks]]`. Empty until the vault loads. */
  readonly allPaths?: ReadonlyArray<string> | undefined;
  /** Target to scroll to after the note renders (search hit line or outline heading). */
  readonly target?: NoteTarget | null | undefined;
  /** Extra remark plugins appended after GFM and math. */
  readonly remarkPlugins?: PluggableList | undefined;
  /** Overrides for rendered elements; merged over the defaults. */
  readonly components?: Components | undefined;
}

export function DocsNote({
  environmentId,
  cwd,
  path,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onOpenNote,
  allPaths,
  target,
  remarkPlugins,
  components,
}: DocsNoteProps) {
  const result = useAtomValue(noteTextAtom(environmentId, cwd, path));
  const text =
    AsyncResult.isSuccess(result) && result.value.exists !== false ? result.value.contents : null;
  const { body } = splitFrontmatter(text ?? "");
  // Frontmatter is stripped before rendering; offset keeps data-line matching the file's own line numbers.
  const lineOffset =
    text === null ? 0 : text.slice(0, text.length - body.length).split("\n").length - 1;
  // Callouts before wikilinks so `[!type]` is read from unsplit text. GitHub alerts are handled by
  // remarkCallouts too (bare `[!NOTE]` sets data-callout), so no remarkGithubAlerts here.
  const plugins: PluggableList = [
    ...BASE_REMARK_PLUGINS,
    remarkCallouts,
    [remarkWikilinks, { allPaths: allPaths ?? [], fromPath: path }],
    ...(remarkPlugins ?? []),
  ];
  const rehypePlugins: PluggableList = [[rehypeNoteAnchors, { lineOffset }]];
  const mergedComponents: Components = {
    a: NoteLink,
    img: NoteImage,
    blockquote: NoteBlockquote,
    ...components,
  };

  return (
    <article aria-label="Note" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          title="Back (Alt+Left)"
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          title="Forward (Alt+Right)"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRightIcon />
        </Button>
        <Breadcrumbs path={path} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {AsyncResult.isFailure(result) ? (
          <p role="alert" className="text-destructive text-sm">
            Could not read {path}.
          </p>
        ) : !AsyncResult.isSuccess(result) ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : result.value.exists === false ? (
          <p className="text-muted-foreground text-sm">{path} does not exist.</p>
        ) : body.trim() === "" ? (
          <p className="text-muted-foreground text-sm">This note is empty.</p>
        ) : (
          <NoteContext value={{ environmentId, cwd, notePath: path, onOpenNote }}>
            <ScrollToTarget target={target} contentKey={`${path}:${body.length}`}>
              <div className="text-sm leading-relaxed">
                {result.value.truncated ? (
                  <p className="mb-3 text-warning-foreground text-xs">
                    This note is too large; showing the first part only.
                  </p>
                ) : null}
                <ReactMarkdown
                  remarkPlugins={plugins}
                  rehypePlugins={rehypePlugins}
                  components={mergedComponents}
                >
                  {body}
                </ReactMarkdown>
              </div>
            </ScrollToTarget>
          </NoteContext>
        )}
      </div>
    </article>
  );
}

/** Scrolls to a line (`data-line`) or heading (`id`) once the rendered note changes. */
function ScrollToTarget({
  target,
  contentKey,
  children,
}: {
  readonly target: NoteTarget | null | undefined;
  readonly contentKey: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- DOM scroll must follow the rendered markdown and the requested target, which only the browser layout knows.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !target) return;
    if (target.heading) {
      const id = `docs-note-${slugifyHeading(target.heading)}`;
      const heading = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      heading?.scrollIntoView({ block: "start" });
      return;
    }
    if (target.line === undefined) return;
    // ponytail: the nearest block at or above the line; approximate for lines inside lists or code.
    let best: HTMLElement | null = null;
    for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (line <= target.line) best = el;
      else break;
    }
    best?.scrollIntoView({ block: "center" });
  }, [target, contentKey]);
  return <div ref={ref}>{children}</div>;
}

function Breadcrumbs({ path }: { readonly path: string }) {
  const segments = path.split("/");
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 truncate">
      <ol className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
        {segments.map((segment, index) => (
          <li
            key={segments.slice(0, index + 1).join("/")}
            className={cn(
              "flex min-w-0 items-center gap-1",
              index === segments.length - 1 && "text-foreground",
            )}
            aria-current={index === segments.length - 1 ? "page" : undefined}
          >
            {index > 0 ? <ChevronRightIcon aria-hidden className="size-3 shrink-0" /> : null}
            <span className="truncate">{segment}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface NoteContextValue {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly notePath: string;
  readonly onOpenNote: (path: string, target?: NoteTarget) => void;
}

/** Reads a `data-*` attribute that a remark plugin put on the hast node. */
function dataAttr(props: object, name: string): string | undefined {
  const value: unknown = (props as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

const NoteContext = createContext<NoteContextValue | null>(null);

function NoteLink({
  href,
  children,
  className,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const note = use(NoteContext);
  const wiki = href?.startsWith("#wikilink:") ? parseWikilinkHref(href) : null;
  if (wiki) {
    if (dataAttr(props, "data-unresolved") === "true") {
      return (
        <span
          title="Not created yet"
          className={cn(
            "text-muted-foreground underline decoration-dashed underline-offset-2",
            className,
          )}
        >
          {children}
        </span>
      );
    }
    return (
      <a
        {...props}
        href={href}
        className={cn("text-primary underline underline-offset-2", className)}
        onClick={(event) => {
          event.preventDefault();
          note?.onOpenNote(wiki.path, wiki.heading ? { heading: wiki.heading } : undefined);
        }}
      >
        {children}
      </a>
    );
  }
  const target = note ? linkedNotePath(note.notePath, href) : null;
  if (note && target !== null) {
    const anchor = href?.split("#")[1];
    return (
      <a
        {...props}
        href={href}
        className={cn("text-primary underline underline-offset-2", className)}
        onClick={(event) => {
          event.preventDefault();
          note.onOpenNote(target, anchor ? { heading: anchor } : undefined);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("text-primary underline underline-offset-2", className)}
    >
      {children}
    </a>
  );
}

/** Parses `#wikilink:<encodedPath>[&h=<encodedHeading>]` as written by remarkWikilinks. */
function parseWikilinkHref(href: string): { readonly path: string; readonly heading?: string } {
  const [encodedPath = "", encodedHeading] = href.slice("#wikilink:".length).split("&h=");
  const path = decodeSegment(encodedPath);
  return encodedHeading === undefined ? { path } : { path, heading: decodeSegment(encodedHeading) };
}

function NoteBlockquote({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"blockquote"> & ExtraProps) {
  const callout = dataAttr(props, "data-callout");
  if (callout === undefined) return <blockquote {...props}>{children}</blockquote>;
  const title = dataAttr(props, "data-callout-title") ?? callout;
  return (
    <blockquote
      data-callout={callout}
      className="my-3 rounded-r-md border-primary border-s-4 bg-muted/40 px-3 py-2"
    >
      <p className="mb-1 font-medium text-sm">{title}</p>
      {children}
    </blockquote>
  );
}

/** Obsidian `![[file.png]]` (via remark) and plain markdown images. */
function NoteImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  const note = use(NoteContext);
  if (src?.startsWith("#embed:")) {
    const path = decodeSegment(src.slice("#embed:".length));
    if (dataAttr(props, "data-unresolved") === "true" || note === null) {
      return <EmbedChip name={alt ?? path} unresolved />;
    }
    return (
      <AssetImage environmentId={note.environmentId} cwd={note.cwd} path={path} alt={alt ?? path} />
    );
  }
  return <img src={src} alt={alt} className="max-w-full" />;
}

function AssetImage({
  environmentId,
  cwd,
  path,
  alt,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly alt: string;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd,
    path,
  });
  if (state._tag === "Success") {
    return <img src={state.url} alt={alt} className="max-w-full rounded-md" />;
  }
  return <EmbedChip name={alt} unresolved={state._tag === "Failure"} />;
}

function EmbedChip({
  name,
  unresolved = false,
}: {
  readonly name: string;
  readonly unresolved?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-muted-foreground text-xs",
        unresolved && "border-dashed",
      )}
      title={unresolved ? "Not created yet" : name}
    >
      <FileIcon aria-hidden className="size-3" />
      {name}
    </span>
  );
}
