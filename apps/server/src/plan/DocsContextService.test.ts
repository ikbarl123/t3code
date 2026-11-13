import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DocsContextService from "./DocsContextService.ts";

const PROJECT_ID = ProjectId.make("project-code");
const DOCS_ID = ProjectId.make("project-docs");
const THREAD = ThreadId.make("thread-1");
const PLAN = "docs/plans/2026-11-11-fixture.md";

const PLAN_TEXT = `---
title: "Fixture"
status: planned
---

## Related
- Feature overviews: [[features/orchestration-v2/overview]], [[features/checkpointing/overview|checkpoints]]
- Missing: [[features/nope/overview]]

## Milestones

- [ ] **M1**: thing
`;

const writeVault = Effect.fn("writeVault")(function* (root: string, files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const [relativePath, contents] of Object.entries(files)) {
    const dir = relativePath.slice(0, relativePath.lastIndexOf("/"));
    yield* fileSystem.makeDirectory(`${root}/${dir}`, { recursive: true });
    yield* fileSystem.writeFileString(`${root}/${relativePath}`, contents);
  }
});

const makeLayer = (docsRoot: string) => {
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(
        Option.some(
          id === DOCS_ID
            ? { id: DOCS_ID, workspaceRoot: docsRoot, docsProjectId: null }
            : { id: PROJECT_ID, workspaceRoot: docsRoot, docsProjectId: DOCS_ID },
        ) as never,
      ),
  });
  const layerKnown = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
    assertContains: () => Effect.void,
    contains: () => Effect.succeed(true),
  });
  const layerFs = WorkspaceFileSystem.layer.pipe(
    Layer.provide(layerKnown),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  );
  return DocsContextService.layer.pipe(
    Layer.provide(layerProjects),
    Layer.provide(layerFs),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-docs-context-test-",
    })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodePath.layer)),
  );
};

const withVault = Effect.fn("withVault")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-docs-ctx-" });
  yield* writeVault(root, files);
  return root;
});

const BASE_FILES = {
  "docs/START.md": "START BODY",
  "docs/AGENTS.md": "AGENTS BODY",
  [PLAN]: PLAN_TEXT,
  "docs/features/orchestration-v2/overview.md": "ORCH BODY",
  "docs/features/checkpointing/overview.md": "CKPT BODY",
};

const forTurn = (planPath: string | null = PLAN) =>
  DocsContextService.DocsContextService.use((svc) =>
    svc.forTurn({ threadId: THREAD, projectId: PROJECT_ID, planPath }),
  );

it.layer(NodeServices.layer)("DocsContextService", (it) => {
  it.effect("assembles START, AGENTS, plan and wikilinked feature overviews, skipping missing", () =>
    Effect.gen(function* () {
      const root = yield* withVault(BASE_FILES);
      const bundle = yield* forTurn().pipe(Effect.provide(makeLayer(root)));
      assert.isNotNull(bundle);
      const text = bundle!.text;
      assert.include(text, "## docs/START.md");
      assert.include(text, "## docs/AGENTS.md");
      assert.include(text, `## ${PLAN}`);
      assert.include(text, "## docs/features/orchestration-v2/overview.md");
      assert.include(text, "## docs/features/checkpointing/overview.md");
      assert.include(text, "ORCH BODY");
      assert.notInclude(text, "## docs/features/nope");
    }),
  );

  it.effect("truncates the bundle at the cap with a marker", () =>
    Effect.gen(function* () {
      const root = yield* withVault({
        ...BASE_FILES,
        "docs/START.md": "x".repeat(DocsContextService.DOCS_BUNDLE_MAX_CHARS + 500),
      });
      const bundle = yield* forTurn().pipe(Effect.provide(makeLayer(root)));
      assert.isNotNull(bundle);
      assert.isAtMost(bundle!.text.length, DocsContextService.DOCS_BUNDLE_MAX_CHARS);
      assert.isTrue(bundle!.text.endsWith("[docs context truncated]"));
    }),
  );

  it.effect("returns null for an unbound thread", () =>
    Effect.gen(function* () {
      const root = yield* withVault(BASE_FILES);
      const bundle = yield* forTurn(null).pipe(Effect.provide(makeLayer(root)));
      assert.isNull(bundle);
    }),
  );

  it.effect("injects on first turn, skips when unchanged, re-injects when a doc changes", () =>
    Effect.gen(function* () {
      const root = yield* withVault(BASE_FILES);
      const fileSystem = yield* FileSystem.FileSystem;
      const turn = Effect.gen(function* () {
        const svc = yield* DocsContextService.DocsContextService;
        const bundle = yield* svc.forTurn({ threadId: THREAD, projectId: PROJECT_ID, planPath: PLAN });
        if (bundle !== null) yield* svc.commit(THREAD, bundle.text);
        return bundle;
      });
      const program = Effect.gen(function* () {
        const first = yield* turn;
        const unchanged = yield* turn;
        yield* fileSystem.writeFileString(`${root}/docs/START.md`, "START CHANGED");
        const changed = yield* turn;
        return { first, unchanged, changed };
      }).pipe(Effect.provide(makeLayer(root)));
      const { first, unchanged, changed } = yield* program;
      assert.isNotNull(first);
      assert.isNull(unchanged);
      assert.isNotNull(changed);
      assert.include(changed!.text, "START CHANGED");
    }),
  );
});
