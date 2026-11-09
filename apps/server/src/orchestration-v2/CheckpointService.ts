import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    readonly linkedWorkspaces?: ReadonlyArray<ProjectLinkedWorkspace>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The run materializing the baseline: its root node, and when it was requested. */
    readonly nodeId: NodeId;
    readonly capturedAt: DateTime.Utc;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
    readonly linkedWorkspaces?: ReadonlyArray<ProjectLinkedWorkspace>;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    readonly forceMissing?: boolean;
    readonly linkedWorkspaces?: ReadonlyArray<ProjectLinkedWorkspace>;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const crypto = yield* Digest.Digest;
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  const scopeId = yield* input.idAllocator.allocate.checkpointScope({
    threadId: input.threadId,
    name: ROOT_CHECKPOINT_SCOPE_NAME,
  });
  return {
    id: scopeId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    parentScopeId: null,
    providerThreadId: input.providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: input.cwd,
    createdAt: input.createdAt,
  } satisfies OrchestrationV2CheckpointScope;
});

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly repoSnapshots?: OrchestrationV2Checkpoint["repoSnapshots"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    ...(input.repoSnapshots && input.repoSnapshots.length > 0
      ? { repoSnapshots: input.repoSnapshots }
      : {}),
    capturedAt: input.capturedAt,
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  CheckpointStore.CheckpointStore | Digest.Digest | IdAllocator.IdAllocatorV2
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Digest.Digest;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Digest.Digest, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);
    const withWorkspaceLocks = <A, E, R>(
      cwds: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const sortedUnique = Array.from(new Set(cwds)).toSorted((a, b) => a.localeCompare(b));
      return sortedUnique.reduceRight(
        (acc, cwd) => workspaceLocks.withLock(cwd, acc),
        effect,
      );
    };

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const captureBaselineInCwd = (cwd: string, checkpointRef: CheckpointRef) =>
      Effect.gen(function* () {
        if (!(yield* isGitCheckpointable(cwd))) {
          return;
        }
        const exists = yield* checkpointStore.hasCheckpointRef({
          cwd,
          checkpointRef,
        });
        if (exists) {
          return;
        }
        yield* checkpointStore
          .captureCheckpoint({
            cwd,
            checkpointRef,
          })
          .pipe(
            Effect.catchTags({
              VcsUnsupportedOperationError: () => Effect.void,
            }),
          );
      });

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      withWorkspaceLocks(
        [
          input.scope.cwd,
          ...(input.linkedWorkspaces ?? []).map((workspace) => workspace.workspaceRoot),
        ],
        Effect.gen(function* () {
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          yield* captureBaselineInCwd(input.scope.cwd, checkpointRef);
          for (const linked of input.linkedWorkspaces ?? []) {
            yield* captureBaselineInCwd(linked.workspaceRoot, checkpointRef).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 linked workspace baseline capture failed", {
                  scopeId: input.scope.id,
                  workspaceRoot: linked.workspaceRoot,
                  cause: String(cause),
                }),
              ),
            );
          }
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointable =
              input.forceMissing !== true && (yield* isGitCheckpointable(input.scope.cwd));
            const available = checkpointable
              ? yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  )
              : false;
            const repoSnapshots: Array<OrchestrationV2RepoCheckpointSnapshot> = [];
            for (const linked of input.linkedWorkspaces ?? []) {
              const linkedCheckpointable =
                input.forceMissing !== true && (yield* isGitCheckpointable(linked.workspaceRoot));
              const linkedAvailable = linkedCheckpointable
                ? yield* checkpointStore
                    .hasCheckpointRef({
                      cwd: linked.workspaceRoot,
                      checkpointRef,
                    })
                    .pipe(Effect.orElseSucceed(() => false))
                : false;
              repoSnapshots.push({
                workspaceRoot: linked.workspaceRoot,
                label: linked.label,
                ref: checkpointRef,
                status: linkedAvailable ? "ready" : "missing",
                files: [],
              });
            }
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
              files: [],
              ...(repoSnapshots.length > 0 ? { repoSnapshots } : {}),
              capturedAt: input.capturedAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const captureRepoDiffFiles = (
      cwd: string,
      scopeId: CheckpointScopeId,
      previousCheckpointRef: CheckpointRef,
      checkpointRef: CheckpointRef,
    ) =>
      Effect.gen(function* () {
        const previousExists = yield* checkpointStore
          .hasCheckpointRef({
            cwd,
            checkpointRef: previousCheckpointRef,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                scopeId,
                checkpointRef: previousCheckpointRef,
                cause: String(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        if (!previousExists) return [];
        const refs = {
          cwd,
          fromCheckpointRef: previousCheckpointRef,
          toCheckpointRef: checkpointRef,
        };
        return yield* Effect.all([
          checkpointStore.diffCheckpoints({
            ...refs,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          }),
          checkpointStore.listAuthoredPaths(refs).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                scopeId,
                checkpointRef,
                cause: String(cause),
              }).pipe(Effect.as(null)),
            ),
          ),
        ]).pipe(
          Effect.map(([diff, authoredPaths]) =>
            parseTurnDiffFilesFromNumstat(diff)
              .filter((file) => !isGitImport(file, authoredPaths))
              .map((file) => ({
                path: file.path,
                kind: "modified",
                additions: file.additions,
                deletions: file.deletions,
              })),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
              scopeId,
              checkpointRef,
              cause: String(cause),
            }).pipe(Effect.as([])),
          ),
        );
      });

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      withWorkspaceLocks(
        [
          input.scope.cwd,
          ...(input.linkedWorkspaces ?? []).map((workspace) => workspace.workspaceRoot),
        ],
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: input.ordinalWithinScope - 1,
                })
              : null;
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const previousCheckpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });

          if (input.forceMissing === true || !(yield* isGitCheckpointable(input.scope.cwd))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const captureStatus = yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
            })
            .pipe(
              Effect.as("ready" as const),
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
              }),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: input.scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as("error" as const)),
              ),
            );

          if (captureStatus !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: captureStatus,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const primaryFiles = yield* captureRepoDiffFiles(
            input.scope.cwd,
            input.scope.id,
            previousCheckpointRef,
            checkpointRef,
          );

          const repoSnapshots: Array<OrchestrationV2RepoCheckpointSnapshot> = [];
          const linkedPrefixedFiles: Array<OrchestrationV2Checkpoint["files"][number]> = [];
          for (const linked of input.linkedWorkspaces ?? []) {
            if (!(yield* isGitCheckpointable(linked.workspaceRoot))) {
              repoSnapshots.push({
                workspaceRoot: linked.workspaceRoot,
                label: linked.label,
                ref: checkpointRef,
                status: "missing",
                files: [],
              });
              continue;
            }
            // Ensure baseline ref exists in linked repo before capturing turn ref
            if (input.ordinalWithinScope > 0) {
              yield* captureBaselineInCwd(linked.workspaceRoot, previousCheckpointRef).pipe(
                Effect.ignore,
              );
            }
            const linkedStatus = yield* checkpointStore
              .captureCheckpoint({
                cwd: linked.workspaceRoot,
                checkpointRef,
              })
              .pipe(
                Effect.as("ready" as const),
                Effect.catchTags({
                  VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
                }),
                Effect.catch(() => Effect.succeed("missing" as const)),
              );
            const linkedFiles =
              linkedStatus === "ready"
                ? yield* captureRepoDiffFiles(
                    linked.workspaceRoot,
                    input.scope.id,
                    previousCheckpointRef,
                    checkpointRef,
                  )
                : [];
            repoSnapshots.push({
              workspaceRoot: linked.workspaceRoot,
              label: linked.label,
              ref: checkpointRef,
              status: linkedStatus,
              files: linkedFiles,
            });
            for (const file of linkedFiles) {
              linkedPrefixedFiles.push({
                ...file,
                path: `[${linked.label}]/${file.path}`,
              });
            }
          }

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files: [...primaryFiles, ...linkedPrefixedFiles],
            ...(repoSnapshots.length > 0 ? { repoSnapshots } : {}),
            capturedAt: input.capturedAt,
          });
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLocks(
        [
          input.scope.cwd,
          ...(input.checkpoint.repoSnapshots ?? []).map((snapshot) => snapshot.workspaceRoot),
        ],
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
          for (const snapshot of input.checkpoint.repoSnapshots ?? []) {
            if (snapshot.status !== "ready") continue;
            yield* checkpointStore
              .restoreCheckpoint({
                cwd: snapshot.workspaceRoot,
                checkpointRef: snapshot.ref,
                fallbackToHead: false,
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 linked workspace checkpoint restore failed", {
                    scopeId: input.scope.id,
                    workspaceRoot: snapshot.workspaceRoot,
                    cause: String(cause),
                  }),
                ),
              );
          }
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>
      withWorkspaceLocks(
        [
          input.scope.cwd,
          ...input.checkpoints.flatMap((checkpoint) =>
            (checkpoint.repoSnapshots ?? []).map((snapshot) => snapshot.workspaceRoot),
          ),
        ],
        Effect.gen(function* () {
          yield* checkpointStore.deleteCheckpointRefs({
            cwd: input.scope.cwd,
            checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),
          });
          const refsByLinkedRoot = new Map<string, Array<CheckpointRef>>();
          for (const checkpoint of input.checkpoints) {
            for (const snapshot of checkpoint.repoSnapshots ?? []) {
              const existing = refsByLinkedRoot.get(snapshot.workspaceRoot) ?? [];
              existing.push(snapshot.ref);
              refsByLinkedRoot.set(snapshot.workspaceRoot, existing);
            }
          }
          for (const [workspaceRoot, checkpointRefs] of refsByLinkedRoot) {
            yield* checkpointStore
              .deleteCheckpointRefs({
                cwd: workspaceRoot,
                checkpointRefs,
              })
              .pipe(Effect.ignore);
          }
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointDeleteStaleRefsError({
              scopeId: input.scope.id,
              checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
              cause,
            }),
        ),
      );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      restore,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
