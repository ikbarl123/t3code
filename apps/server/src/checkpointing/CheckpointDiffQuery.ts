import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const DIFF_TRUNCATED_MARKER = "\n\n[truncated]";

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function prefixDiffHeaderPaths(patch: string, label: string): string {
  if (!patch) return "";
  return patch
    .replace(/^diff --git a\/(.*?) b\/(.*)$/gm, `diff --git a/[${label}]/$1 b/[${label}]/$2`)
    .replace(/^--- a\/(.*)$/gm, `--- a/[${label}]/$1`)
    .replace(/^\+\+\+ b\/(.*)$/gm, `+++ b/[${label}]/$1`);
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const readyCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "ready" &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const maxTurnCount = readyCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = readyCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      // Capture compares against the preceding scope ordinal, even when that
      // checkpoint belongs to a stopped run or has no run.
      const parentCheckpoint =
        input.fromTurnCount === input.toTurnCount - 1
          ? projection.checkpoints.find(
              (checkpoint) =>
                checkpoint.status === "ready" &&
                checkpoint.scopeId === toCheckpoint.scopeId &&
                checkpoint.ordinalWithinScope === toCheckpoint.ordinalWithinScope - 1,
            )
          : undefined;

      const firstScope =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
          : undefined;
      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : yield* checkpointRefForScopeOrdinal({
                scopeId: firstScope.id,
                ordinalWithinScope: 0,
              }).pipe(Effect.provideService(Digest.Digest, digest))
          : (
              parentCheckpoint ??
              readyCheckpoints.find(
                (checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount,
              )
            )?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const computeCwdDiff = (cwd: string, maxBytes: number) =>
        Effect.gen(function* () {
          const comparison = {
            cwd,
            fromCheckpointRef,
            toCheckpointRef: toCheckpoint.ref,
            fallbackFromToHead: false,
            ignoreWhitespace,
          };
          const authoredPaths = yield* checkpointStore
            .listAuthoredPaths(comparison)
            .pipe(Effect.orElseSucceed(() => null));
          const files =
            authoredPaths === null
              ? []
              : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
                  Effect.map(parseTurnDiffFilesFromNumstat),
                  Effect.orElseSucceed(() => []),
                );
          const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
          const pathBatches =
            retainedFiles.length === files.length ? [undefined] : batchFilePaths(retainedFiles);
          let repoDiff = "";
          let remaining = maxBytes;
          let truncated = false;
          for (const filePaths of pathBatches) {
            const patch = yield* checkpointStore
              .diffCheckpoints({
                ...comparison,
                ...(filePaths === undefined ? {} : { filePaths }),
                maxOutputBytes: remaining + 1,
              })
              .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
            const patchBytes = Buffer.byteLength(patch);
            repoDiff += patch;
            if (patchBytes > remaining) {
              truncated = true;
              break;
            }
            remaining -= patchBytes;
          }
          return { repoDiff, truncated };
        });

      const requestedWorkspaceRoot = input.workspaceRoot;
      let diff = "";
      if (requestedWorkspaceRoot !== undefined && requestedWorkspaceRoot !== toScope.cwd) {
        const snapshot = (toCheckpoint.repoSnapshots ?? []).find(
          (candidate) => candidate.workspaceRoot === requestedWorkspaceRoot,
        );
        if (snapshot !== undefined && snapshot.status === "ready") {
          const { repoDiff, truncated } = yield* computeCwdDiff(
            snapshot.workspaceRoot,
            CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          );
          diff = truncated
            ? new TextDecoder().decode(
                Buffer.from(repoDiff).subarray(
                  0,
                  CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
                ),
                { stream: true },
              ) + DIFF_TRUNCATED_MARKER
            : repoDiff;
        }
      } else {
        const primary = yield* computeCwdDiff(toScope.cwd, CHECKPOINT_DIFF_MAX_OUTPUT_BYTES);
        diff = primary.repoDiff;
        let wasTruncated = primary.truncated;
        let remainingBytes = Math.max(
          0,
          CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(diff),
        );
        if (requestedWorkspaceRoot === undefined && !wasTruncated) {
          for (const snapshot of toCheckpoint.repoSnapshots ?? []) {
            if (snapshot.status !== "ready" || remainingBytes <= 0) continue;
            const linked = yield* computeCwdDiff(snapshot.workspaceRoot, remainingBytes).pipe(
              Effect.orElseSucceed(() => ({ repoDiff: "", truncated: false })),
            );
            if (linked.repoDiff.length > 0) {
              const prefixed = prefixDiffHeaderPaths(linked.repoDiff, snapshot.label);
              if (diff.length > 0 && !diff.endsWith("\n")) diff += "\n";
              diff += prefixed;
              remainingBytes = Math.max(
                0,
                CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(diff),
              );
            }
            if (linked.truncated || Buffer.byteLength(diff) > CHECKPOINT_DIFF_MAX_OUTPUT_BYTES) {
              wasTruncated = true;
              break;
            }
          }
        }
        if (wasTruncated) {
          diff =
            new TextDecoder().decode(
              Buffer.from(diff).subarray(
                0,
                CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
              ),
              { stream: true },
            ) + DIFF_TRUNCATED_MARKER;
        }
      }

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
