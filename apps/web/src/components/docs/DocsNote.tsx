import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { createContext, use, type AnchorHTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";

const BASE_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];

/** Drops a leading `---` YAML block; properties are shown by the side panel instead. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/** Vault-relative path of a markdown link target, or null for anything that is not a note. */
export function linkedNotePath(notePath: string, href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) {
    return null;
  }
  const [target] = href.split("#");
  if (!target || !/\.md$/i.test(target)) return null;
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
  readonly onOpenNote: (path: string) => void;
  /** Extra remark plugins appended after GFM and math, for Obsidian syntax. */
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
  remarkPlugins,
  components,
}: DocsNoteProps) {
  const result = useAtomValue(
    projectEnvironment.readFile({
      environmentId,
      input: { cwd, relativePath: path, allowMissing: true },
    }),
  );
  const plugins = remarkPlugins ? [...BASE_REMARK_PLUGINS, ...remarkPlugins] : BASE_REMARK_PLUGINS;
  const mergedComponents: Components = { a: NoteLink, ...components };

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
        ) : stripFrontmatter(result.value.contents).trim() === "" ? (
          <p className="text-muted-foreground text-sm">This note is empty.</p>
        ) : (
          <NoteContext value={{ notePath: path, onOpenNote }}>
            <div className="text-sm leading-relaxed">
              <ReactMarkdown remarkPlugins={plugins} components={mergedComponents}>
                {stripFrontmatter(result.value.contents)}
              </ReactMarkdown>
            </div>
          </NoteContext>
        )}
      </div>
    </article>
  );
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

const NoteContext = createContext<{
  readonly notePath: string;
  readonly onOpenNote: (path: string) => void;
} | null>(null);

function NoteLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const note = use(NoteContext);
  const target = note ? linkedNotePath(note.notePath, href) : null;
  if (target !== null) {
    return (
      <a
        {...props}
        href={href}
        className="text-primary underline underline-offset-2"
        onClick={(event) => {
          event.preventDefault();
          note?.onOpenNote(target);
        }}
      />
    );
  }
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    />
  );
}
