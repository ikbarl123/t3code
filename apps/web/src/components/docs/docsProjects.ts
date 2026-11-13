import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

/** Distinct docs projects that the given projects link to, in project order. */
export function docsProjectRefs(projects: ReadonlyArray<EnvironmentProject>): ScopedProjectRef[] {
  const refs = new Map<string, ScopedProjectRef>();
  for (const project of projects) {
    if (!project.docsProjectId) continue;
    const ref = scopeProjectRef(project.environmentId, project.docsProjectId);
    refs.set(scopedProjectKey(ref), ref);
  }
  return [...refs.values()];
}
