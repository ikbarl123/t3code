import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { projectEnvironment } from "~/state/projects";

// Shared placeholder for "no note": subscribing to it reads nothing from the environment.
const NO_NOTE = Atom.make(AsyncResult.initial());

/** One atom per (environment, folder, note); DocsNote, the side panel and refresh share it. */
export function noteTextAtom(
  environmentId: EnvironmentId,
  cwd: string | null,
  path: string | null,
) {
  if (cwd === null || path === null) return NO_NOTE;
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: path, allowMissing: true },
  });
}
