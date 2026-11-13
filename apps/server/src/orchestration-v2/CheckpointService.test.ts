import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect(
  "bounds a slow baseline snapshot but waits for an in-flight capture of the same ref",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
        threadId: ThreadId.make("thread:slow-baseline"),
        runId: RunId.make("run:slow-baseline:1"),
        nodeId: NodeId.make("node:slow-baseline:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/slow",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const snapshots = yield* Ref.make(0);
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ checkpointRef }) =>
                Effect.gen(function* () {
                  yield* Ref.update(snapshots, (count) => count + 1);
                  yield* Deferred.succeed(firstSnapshotStarted, undefined);
                  yield* Effect.sleep("10 seconds");
                  yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
        const postTurn = yield* checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const waitingBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 1 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
        assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

        const slowBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 2 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(slowBaseline))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), 2);
        assert.strictEqual((yield* Ref.get(refs)).size, 1);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);

it.effect(
  "captures, diffs, and restores linkedWorkspaces alongside the primary scope cwd",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:multi-repo"),
        threadId: ThreadId.make("thread:multi-repo"),
        runId: RunId.make("run:multi-repo:1"),
        nodeId: NodeId.make("node:multi-repo:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:multi-repo"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/docs",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const linkedWorkspaces = [
        {
          id: "mercusuar",
          label: "mercusuar",
          workspaceRoot: "/repo/mercusuar",
        },
      ];
      const capturedCwds: string[] = [];
      const restoredCwds: string[] = [];

      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: () => Effect.succeed(true),
              captureCheckpoint: ({ cwd }) =>
                Effect.sync(() => {
                  capturedCwds.push(cwd);
                }),
              diffCheckpoints: ({ cwd, toCheckpointRef }) =>
                Effect.succeed(
                  toCheckpointRef.includes("-rollback-drift-check")
                    ? ""
                    : cwd === "/repo/docs"
                      ? "2\t0\tdocs/plan.md\0"
                      : "5\t1\tsrc/index.ts\0",
                ),
              listAuthoredPaths: () => Effect.succeed(null),
              deleteCheckpointRefs: () => Effect.void,
              restoreCheckpoint: ({ cwd }) =>
                Effect.sync(() => {
                  restoredCwds.push(cwd);
                  return true;
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const checkpoint = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });

        assert.strictEqual(checkpoint.status, "ready");
        assert.deepEqual(
          checkpoint.files.map((file) => file.path),
          ["docs/plan.md", "[mercusuar]/src/index.ts"],
        );
        assert.strictEqual(checkpoint.repoSnapshots?.length, 1);
        assert.strictEqual(checkpoint.repoSnapshots?.[0]?.workspaceRoot, "/repo/mercusuar");
        assert.strictEqual(checkpoint.repoSnapshots?.[0]?.label, "mercusuar");

        // When staleCheckpoints is absent, linked restore is skipped because drift cannot be checked
        const restoreResult1 = yield* checkpoints.restore({ scope, checkpoint });
        assert.deepEqual(restoredCwds, ["/repo/docs"]);
        assert.deepEqual(restoreResult1.skippedLinkedRoots, ["/repo/mercusuar"]);

        // When a subsequent checkpoint is in staleCheckpoints, drift is checked and linked restore succeeds
        restoredCwds.length = 0;
        const checkpoint2 = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 2,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 2,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });
        const restoreResult2 = yield* checkpoints.restore({ scope, checkpoint, staleCheckpoints: [checkpoint2] });
        assert.deepEqual(restoredCwds, ["/repo/docs", "/repo/mercusuar"]);
        assert.deepEqual(restoreResult2.skippedLinkedRoots, []);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect(
  "skips restoring linkedWorkspaces when external drift or check failure occurs, using sibling temp refs",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:drift-check"),
        threadId: ThreadId.make("thread:drift-check"),
        runId: RunId.make("run:drift-check:1"),
        nodeId: NodeId.make("node:drift-check:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:drift-check"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/docs",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const linkedWorkspaces = [
        {
          id: "mercusuar",
          label: "mercusuar",
          workspaceRoot: "/repo/mercusuar",
        },
      ];
      const capturedRefs: string[] = [];
      const restoredCwds: string[] = [];
      const deletedRefs: string[] = [];
      let diffOutput = "1\t0\text.ts\0";
      let captureError: VcsProcessTimeoutError | null = null;

      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: () => Effect.succeed(true),
              captureCheckpoint: ({ checkpointRef }) =>
                Effect.gen(function* () {
                  capturedRefs.push(checkpointRef);
                  if (captureError) return yield* Effect.fail(captureError);
                }),
              diffCheckpoints: () => Effect.succeed(diffOutput),
              listAuthoredPaths: () => Effect.succeed(null),
              deleteCheckpointRefs: ({ checkpointRefs }) =>
                Effect.sync(() => {
                  deletedRefs.push(...checkpointRefs);
                }),
              restoreCheckpoint: ({ cwd }) =>
                Effect.sync(() => {
                  restoredCwds.push(cwd);
                  return true;
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const checkpoint1 = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });
        const checkpoint2 = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 2,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 2,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });

        const latestRef = checkpoint2.repoSnapshots?.[0]?.ref;
        assert.ok(latestRef);

        // Case 1: Drift detected (diffOutput is non-empty)
        yield* checkpoints.restore({
          scope,
          checkpoint: checkpoint1,
          staleCheckpoints: [checkpoint2],
        });
        // Sibling ref was used (ends with -rollback-drift-check, not /rollback-drift-check)
        const expectedTempRef = `${latestRef}-rollback-drift-check`;
        assert.ok(capturedRefs.includes(expectedTempRef));
        assert.ok(!capturedRefs.some((ref) => ref.includes("/rollback-drift-check")));
        assert.ok(deletedRefs.includes(expectedTempRef));
        // Linked workspace was skipped because of drift; only primary cwd restored
        assert.deepEqual(restoredCwds, ["/repo/docs"]);

        // Case 2: Capture fails during drift check -> safely treated as drifted (skipped)
        restoredCwds.length = 0;
        deletedRefs.length = 0;
        captureError = new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: "/repo/docs",
          timeoutMs: 30000,
        });
        yield* checkpoints.restore({
          scope,
          checkpoint: checkpoint1,
          staleCheckpoints: [checkpoint2],
        });
        assert.deepEqual(restoredCwds, ["/repo/docs"]);
        assert.ok(deletedRefs.includes(expectedTempRef));

        // Case 3: No drift (diffOutput is empty, capture succeeds) -> linked workspace is restored
        restoredCwds.length = 0;
        captureError = null;
        diffOutput = "";
        yield* checkpoints.restore({
          scope,
          checkpoint: checkpoint1,
          staleCheckpoints: [checkpoint2],
        });
        assert.deepEqual(restoredCwds, ["/repo/docs", "/repo/mercusuar"]);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect(
  "captures and restores linkedWorkspaces when the primary workspace is non-git / missing",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:non-git-primary"),
        threadId: ThreadId.make("thread:non-git-primary"),
        runId: RunId.make("run:non-git-primary:1"),
        nodeId: NodeId.make("node:non-git-primary:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:non-git-primary"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/vault/docs",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const linkedWorkspaces = [
        {
          id: "service",
          label: "service",
          workspaceRoot: "/repo/service",
        },
      ];
      const capturedCwds: string[] = [];
      const restoredCwds: string[] = [];

      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: (cwd: string) => Effect.succeed(cwd !== "/vault/docs"),
              hasCheckpointRef: () => Effect.succeed(true),
              captureCheckpoint: ({ cwd }) =>
                Effect.sync(() => {
                  capturedCwds.push(cwd);
                }),
              diffCheckpoints: ({ toCheckpointRef }) =>
                Effect.succeed(
                  toCheckpointRef.includes("-rollback-drift-check") ? "" : "3\t0\tsrc/api.ts\0",
                ),
              listAuthoredPaths: () => Effect.succeed(null),
              deleteCheckpointRefs: () => Effect.void,
              restoreCheckpoint: ({ cwd }) =>
                Effect.sync(() => {
                  restoredCwds.push(cwd);
                  return true;
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const checkpoint = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });

        assert.strictEqual(checkpoint.status, "missing");
        assert.deepEqual(
          checkpoint.files.map((file) => file.path),
          ["[service]/src/api.ts"],
        );
        assert.strictEqual(checkpoint.repoSnapshots?.length, 1);
        assert.strictEqual(checkpoint.repoSnapshots?.[0]?.status, "ready");
        assert.strictEqual(checkpoint.repoSnapshots?.[0]?.workspaceRoot, "/repo/service");

        const checkpoint2 = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 2,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 2,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
        });

        yield* checkpoints.restore({
          scope,
          checkpoint,
          staleCheckpoints: [checkpoint2],
        });
        assert.deepEqual(restoredCwds, ["/repo/service"]);

        const forceMissingCheckpoint = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 3,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 3,
          capturedAt: scope.createdAt,
          linkedWorkspaces,
          forceMissing: true,
        });
        assert.strictEqual(forceMissingCheckpoint.status, "missing");
        assert.deepEqual(forceMissingCheckpoint.files, []);
        assert.strictEqual(forceMissingCheckpoint.repoSnapshots?.[0]?.status, "missing");
        assert.deepEqual(forceMissingCheckpoint.repoSnapshots?.[0]?.files, []);
      }).pipe(Effect.provide(layerTest));
    }),
);
