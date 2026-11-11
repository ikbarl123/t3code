import { createContext, use } from "react";

import type { LinkIndex } from "./backlinks";
import type { VaultStatus } from "./useVaultIndex";

/** Where to land inside a note: a 1-based source line (search hits) or a heading slug (outline, `[[x#h]]`). */
export interface NoteTarget {
  readonly line?: number;
  readonly heading?: string;
}

export type NoteStatus = "loading" | "ready" | "missing" | "error";

export interface DocsPageControls {
  readonly openNote: (path: string, target?: NoteTarget) => void;
  readonly closeSearch: () => void;
  readonly activePath: string | null;
  /** Full note text including frontmatter; null while loading or when absent. */
  readonly activeText: string | null;
  readonly noteStatus: NoteStatus;
  readonly vault: {
    readonly paths: ReadonlyArray<string>;
    readonly index: LinkIndex | null;
    readonly status: VaultStatus;
  };
}

const DocsPageContext = createContext<DocsPageControls | null>(null);

export const DocsPageProvider = DocsPageContext.Provider;

/** For slot panels (search, note details) rendered inside DocsPage. */
export function useDocsPage(): DocsPageControls {
  const controls = use(DocsPageContext);
  if (!controls) throw new Error("useDocsPage must be used inside DocsPage");
  return controls;
}
