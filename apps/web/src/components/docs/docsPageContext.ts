import { createContext, use } from "react";

export interface DocsPageControls {
  /** Opens a vault-relative note; `line` is reserved for search results and not scrolled to yet. */
  readonly openNote: (path: string, line?: number) => void;
  readonly closeSearch: () => void;
}

const DocsPageContext = createContext<DocsPageControls | null>(null);

export const DocsPageProvider = DocsPageContext.Provider;

/** For slot panels (search, note details) rendered inside DocsPage. */
export function useDocsPage(): DocsPageControls {
  const controls = use(DocsPageContext);
  if (!controls) throw new Error("useDocsPage must be used inside DocsPage");
  return controls;
}
