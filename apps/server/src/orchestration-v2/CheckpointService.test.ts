import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
              diffCheckpoints: ({ cwd }) =>
                Effect.succeed(
                  cwd === "/repo/docs"
                    ? "2\t0\tdocs/plan.md\0"
                    : "5\t1\tsrc/index.ts\0",
                ),
              listAuthoredPaths: () => Effect.succeed(null),
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

        yield* checkpoints.restore({ scope, checkpoint });
        assert.deepEqual(restoredCwds, ["/repo/docs", "/repo/mercusuar"]);
      }).pipe(Effect.provide(layerTest));
    }),
);
