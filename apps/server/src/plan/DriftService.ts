// @effect-diagnostics nodeBuiltinImport:off
import { matchesGlob } from "node:path";
import type { DriftItem, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

export const DOCS_SYNC_PATH = "docs/docs-sync.json";

const DocsSyncRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  when: Schema.String,
  expect: TrimmedNonEmptyString,
  message: Schema.String,
});
export type DocsSyncRule = typeof DocsSyncRule.Type;
const DocsSyncConfig = Schema.Struct({ rules: Schema.Array(DocsSyncRule) });
const decodeDocsSync = Schema.decodeUnknownOption(Schema.fromJsonString(DocsSyncConfig));

export const DEFAULT_RULES: ReadonlyArray<DocsSyncRule> = [
  {
    id: "migration-ddl",
    when: "apps/server/src/persistence/Migrations/**",
    expect: "docs/ddl/**",
    message: "Migration changed: update the DDL registry in docs/ddl.",
  },
  {
    id: "feature-doc",
    when: "{apps,packages}/*/src/**",
    expect: "docs/features/**",
    message: "Source changed: check the matching feature overview in docs/features.",
  },
];

/** Rules from docs-sync.json text. Missing or malformed config falls back to the defaults. */
export const rulesFromConfig = (text: string | null): ReadonlyArray<DocsSyncRule> => {
  if (text === null) return DEFAULT_RULES;
  const config = decodeDocsSync(text);
  return Option.isSome(config) ? config.value.rules : DEFAULT_RULES;
};

/** Changed file paths from a git patch's `diff --git a/X b/Y` headers. Quoted paths are skipped. */
export const changedPathsFromPatch = (patch: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match !== null) {
      // Both sides, so a file moved out of a watched folder still counts as a change there.
      paths.add(match[1]!);
      paths.add(match[2]!);
    }
  }
  return [...paths];
};

/** Pure: which rules fire for these changed paths and whether their expected path also changed. */
export const evaluateRules = (
  rules: ReadonlyArray<DocsSyncRule>,
  changed: ReadonlyArray<string>,
  matches: (path: string, pattern: string) => boolean,
): ReadonlyArray<DriftItem> =>
  rules.flatMap((rule) => {
    if (!changed.some((path) => matches(path, rule.when))) return [];
    if (changed.some((path) => matches(path, rule.expect))) return [];
    return [{ rule: rule.id, message: rule.message, expectedPath: rule.expect }];
  });

export class DriftService extends Context.Service<
  DriftService,
  {
    readonly check: (input: {
      readonly threadId: ThreadId;
      readonly turnId: RunId;
    }) => Effect.Effect<ReadonlyArray<DriftItem>>;
  }
>()("t3/plan/DriftService") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;

  const docsRoot = Effect.fn("DriftService.docsRoot")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId);
    const docsProjectId = Option.isSome(project) ? project.value.docsProjectId : null;
    if (!docsProjectId) return null;
    const docs = yield* projects.getById(docsProjectId);
    return Option.isSome(docs) ? docs.value.workspaceRoot : null;
  });

  const loadRules = Effect.fn("DriftService.loadRules")(function* (cwd: string) {
    const file = yield* workspaceFileSystem
      .readFile({ cwd, relativePath: DOCS_SYNC_PATH })
      .pipe(Effect.option);
    return rulesFromConfig(
      Option.isSome(file) && !file.value.truncated ? file.value.contents : null,
    );
  });

  const check: DriftService["Service"]["check"] = Effect.fn("DriftService.check")(
    function* (input) {
      const context = yield* threads.getCheckpointContext(input.threadId).pipe(Effect.option);
      if (Option.isNone(context)) return [];
      const checkpoint = context.value.checkpoints.find(
        (candidate) => candidate.runId === input.turnId && candidate.status === "ready",
      );
      const ordinal = checkpoint?.appRunOrdinal ?? 0;
      if (ordinal === 0) return [];

      const shell = yield* threads.getThreadShell(input.threadId).pipe(Effect.option);
      if (Option.isNone(shell) || shell.value === null || !shell.value.planPath) return [];
      const root = yield* docsRoot(shell.value.projectId).pipe(Effect.option);
      if (Option.isNone(root) || root.value === null) return [];

      const diff = yield* diffs
        .getTurnDiff({
          threadId: input.threadId,
          fromTurnCount: Math.max(0, ordinal - 1),
          toTurnCount: ordinal,
        })
        .pipe(Effect.option);
      if (Option.isNone(diff)) return [];

      const rules = yield* loadRules(root.value);
      return evaluateRules(rules, changedPathsFromPatch(diff.value.diff), matchesGlob);
    },
  );

  return DriftService.of({ check });
});

export const layer = Layer.effect(DriftService, make);
