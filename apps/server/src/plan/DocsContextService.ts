import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

export const DOCS_BUNDLE_MAX_CHARS = 40_000;
const TRUNCATION_MARKER = "\n\n[docs context truncated]";
const RELATED_HEADING = "## Related";
const FEATURE_LINK = /\[\[(features\/[^\]|#]+)(?:\|[^\]]*)?\]\]/g;

export interface DocsBundle {
  readonly text: string;
}

/**
 * Docs context for the turn-start prompt. `forTurn` returns a bundle only when it differs from the
 * one last committed for the thread; `commit` records it once the provider accepted the turn.
 *
 * ponytail: the last-injected text map lives in memory (bounded by thread count x 40k), so after a restart the next turn re-injects once.
 * Upgrade to a projection field if that duplicate becomes noticeable.
 * ponytail: no mtime cache. WorkspaceFileSystem exposes no mtime and the vault is small, so each
 * turn re-reads the (capped) files. Add `modifiedAt` to the metadata to cache by mtime.
 */
export class DocsContextService extends Context.Service<
  DocsContextService,
  {
    readonly forTurn: (input: {
      readonly threadId: string;
      readonly projectId: ProjectId;
      readonly planPath: string | null;
    }) => Effect.Effect<DocsBundle | null>;
    readonly commit: (threadId: string, text: string) => Effect.Effect<void>;
  }
>()("t3/plan/DocsContextService") {}

/** Feature overview paths named by wikilinks in the plan's Related section, as vault `docs/` paths. */
const relatedFeatureDocs = (planText: string): ReadonlyArray<string> => {
  const lines = planText.split("\n");
  const start = lines.indexOf(RELATED_HEADING);
  if (start === -1) return [];
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
  const section = lines.slice(start + 1, end).join("\n");
  const paths = [...section.matchAll(FEATURE_LINK)].map((match) => {
    const target = match[1]!.trim();
    return `docs/${target.endsWith(".md") ? target : `${target}.md`}`;
  });
  return [...new Set(paths)];
};

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const injectedText = new Map<string, string>();

  const readOptional = (cwd: string, relativePath: string) =>
    workspaceFileSystem.readFile({ cwd, relativePath, allowMissing: true }).pipe(
      Effect.map((file) => (file.exists === false ? null : file.contents)),
      Effect.orElseSucceed(() => null),
    );

  const assemble = Effect.fn("DocsContextService.assemble")(function* (
    cwd: string,
    planPath: string,
  ) {
    const planText = yield* readOptional(cwd, planPath);
    const featureDocs = relatedFeatureDocs(planText ?? "").filter(
      (docPath) => !path.isAbsolute(docPath) && !docPath.split(/[\\/]/).includes(".."),
    );
    const sectionPaths = ["docs/START.md", "docs/AGENTS.md", planPath, ...featureDocs];
    const sections = yield* Effect.forEach(sectionPaths, (relativePath) =>
      readOptional(cwd, relativePath).pipe(
        Effect.map((contents) =>
          contents === null ? null : `## ${relativePath}\n\n${contents.trim()}`,
        ),
      ),
    );
    const text = ["# Docs context", ...sections.filter((s) => s !== null)].join("\n\n");
    return text.length > DOCS_BUNDLE_MAX_CHARS
      ? text.slice(0, DOCS_BUNDLE_MAX_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
      : text;
  });

  const forTurn: DocsContextService["Service"]["forTurn"] = Effect.fn("DocsContextService.forTurn")(
    function* (input) {
      const { threadId, planPath } = input;
      if (planPath === null) return null;
      // Absolute and `~` paths would read host files outside the docs project.
      if (
        path.isAbsolute(planPath) ||
        planPath.startsWith("~") ||
        planPath.split(/[\\/]/).includes("..")
      ) {
        return null;
      }
      const project = yield* projects
        .getById(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const docsProjectId = Option.isSome(project) ? project.value.docsProjectId : null;
      if (!docsProjectId) return null;
      const docs = yield* projects
        .getById(docsProjectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(docs)) return null;

      const text = yield* assemble(docs.value.workspaceRoot, planPath).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (text === null) return null;
      return injectedText.get(threadId) === text ? null : { text };
    },
  );

  const commit: DocsContextService["Service"]["commit"] = (threadId, text) =>
    Effect.sync(() => {
      injectedText.set(threadId, text);
    });

  return DocsContextService.of({ forTurn, commit });
});

export const layer = Layer.effect(DocsContextService, make);
