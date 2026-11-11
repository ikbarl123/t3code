import type { EnvironmentId } from "@t3tools/contracts";

import { projectEnvironment } from "~/state/projects";

/** One atom per (environment, folder, note); DocsNote, the side panel and refresh share it. */
export function noteTextAtom(environmentId: EnvironmentId, cwd: string, path: string) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: path, allowMissing: true },
  });
}
