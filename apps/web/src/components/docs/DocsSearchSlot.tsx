import type { EnvironmentId } from "@t3tools/contracts";

import { DocsSearchPanel } from "./DocsSearchPanel";
import { useDocsPage } from "./docsPageContext";

/** Search panel wired to DocsPage's note controls; rendered inside DocsPage's provider. */
export function DocsSearchSlot({
  environmentId,
  docsRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly docsRoot: string;
}) {
  const { openNote, closeSearch } = useDocsPage();
  return (
    <DocsSearchPanel
      environmentId={environmentId}
      docsRoot={docsRoot}
      autoFocus
      onOpenNote={(path, line) => openNote(path, line === undefined ? undefined : { line })}
      onClose={closeSearch}
    />
  );
}
