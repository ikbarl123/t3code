import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PlanError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as PlanService from "./PlanService.ts";

const FIXTURE = `---
title: "Docs-Driven Development"
status: planned
updated: 2026-11-01
---

# Docs-Driven Development

## Milestones

- [ ] **M1**: Contracts
- [x] **M2**: Projection
- [ ] **M3**: PlanService — Scope: apps/server

## Progress Log

- 2026-11-11: Plan created.

## Open Questions
- none
`;

describe("parsePlan", () => {
  it("reads frontmatter, milestones and progress log", () => {
    const plan = PlanService.parsePlan(FIXTURE);
    assert.deepStrictEqual(plan, {
      title: "Docs-Driven Development",
      status: "planned",
      milestones: [
        { id: "M1", text: "Contracts", done: false },
        { id: "M2", text: "Projection", done: true },
        { id: "M3", text: "PlanService — Scope: apps/server", done: false },
      ],
      progressLog: ["2026-11-11: Plan created."],
    });
  });

  it("returns empty milestones and log when sections are absent", () => {
    const plan = PlanService.parsePlan("---\ntitle: T\nstatus: draft\n---\n");
    assert.deepStrictEqual(plan.milestones, []);
    assert.deepStrictEqual(plan.progressLog, []);
  });
});

describe("CRLF plans", () => {
  const crlf = FIXTURE.replace(/\n/g, "\r\n");
  it("parses and toggles while keeping CRLF endings", () => {
    assert.deepStrictEqual(
      PlanService.parsePlan(crlf).milestones,
      PlanService.parsePlan(FIXTURE).milestones,
    );
    const next = PlanService.setMilestone(crlf, "M1", true, "2026-11-12")!;
    assert.isTrue(next.includes("\r\n"));
    assert.isFalse(/[^\r]\n/.test(next));
    assert.isTrue(PlanService.parsePlan(next).milestones[0]!.done);
  });
});

describe("setMilestone", () => {
  it("toggles checkbox, bumps updated and appends a log line", () => {
    const next = PlanService.setMilestone(FIXTURE, "M1", true, "2026-11-12");
    assert.isDefined(next);
    const plan = PlanService.parsePlan(next!);
    assert.isTrue(plan.milestones[0]!.done);
    assert.deepStrictEqual(plan.progressLog, [
      "2026-11-11: Plan created.",
      "2026-11-12: M1 marked done (via UI)",
    ]);
    assert.include(next!, "updated: 2026-11-12");
  });

  it("round-trips: done then reopened restores the checkbox state", () => {
    const done = PlanService.setMilestone(FIXTURE, "M1", true, "2026-11-12")!;
    const reopened = PlanService.setMilestone(done, "M1", false, "2026-11-12")!;
    assert.isFalse(PlanService.parsePlan(reopened).milestones[0]!.done);
    assert.include(reopened, "- 2026-11-12: M1 reopened (via UI)");
  });

  it("is a no-op when the milestone already has the requested state", () => {
    assert.strictEqual(PlanService.setMilestone(FIXTURE, "M2", true, "2026-11-12"), FIXTURE);
  });

  it("returns undefined for an unknown milestone id", () => {
    assert.isUndefined(PlanService.setMilestone(FIXTURE, "M9", true, "2026-11-12"));
  });
});

const PROJECT_ID = ProjectId.make("project-code");
const DOCS_ID = ProjectId.make("project-docs");
const BOUND = ThreadId.make("thread-bound");
const UNBOUND = ThreadId.make("thread-unbound");
const ESCAPE = ThreadId.make("thread-escape");

const makeLayer = (docsRoot: string) => {
  const planFor = (planPath: string | null, projectDocs: ProjectId | null = DOCS_ID) => ({
    projectId: PROJECT_ID,
    planPath,
    projectDocs,
  });
  const shells: Record<string, ReturnType<typeof planFor>> = {
    [BOUND]: planFor("docs/plans/fixture.md"),
    [UNBOUND]: planFor(null),
    [ESCAPE]: planFor("../outside.md"),
  };
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
  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => {
      const shell = shells[threadId];
      return Effect.succeed(
        shell === undefined
          ? null
          : ({ id: threadId, projectId: shell.projectId, planPath: shell.planPath } as never),
      );
    },
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
  return PlanService.layer.pipe(
    Layer.provide(layerProjects),
    Layer.provide(layerThreads),
    Layer.provide(layerFs),
    Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-plan-service-test-",
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodePath.layer)),
  );
};

const withDocsRoot = Effect.fn("withDocsRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-plan-docs-" });
  yield* fileSystem.makeDirectory(`${root}/docs/plans`, { recursive: true });
  yield* fileSystem.writeFileString(`${root}/docs/plans/fixture.md`, FIXTURE);
  return root;
});

it.layer(NodeServices.layer)("PlanService", (it) => {
  it.effect("reads a bound plan", () =>
    Effect.gen(function* () {
      const root = yield* withDocsRoot();
      const plan = yield* PlanService.PlanService.use((svc) => svc.read({ threadId: BOUND })).pipe(
        Effect.provide(makeLayer(root)),
      );
      assert.strictEqual(plan.title, "Docs-Driven Development");
      assert.strictEqual(plan.milestones.length, 3);
    }),
  );

  it.effect("toggle round-trips through the file", () =>
    Effect.gen(function* () {
      const root = yield* withDocsRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      const layer = makeLayer(root);
      yield* PlanService.PlanService.use((svc) =>
        svc.toggleMilestone({ threadId: BOUND, id: "M1", done: true }),
      ).pipe(Effect.provide(layer));
      const onDisk = yield* fileSystem.readFileString(`${root}/docs/plans/fixture.md`);
      assert.include(onDisk, "- [x] **M1**: Contracts");
      assert.match(onDisk, /- \d{4}-\d{2}-\d{2}: M1 marked done \(via UI\)/);

      const reopened = yield* PlanService.PlanService.use((svc) =>
        svc.toggleMilestone({ threadId: BOUND, id: "M1", done: false }),
      ).pipe(Effect.provide(layer));
      assert.isFalse(reopened.milestones[0]!.done);
    }),
  );

  it.effect("rejects an unbound thread with not_bound", () =>
    Effect.gen(function* () {
      const root = yield* withDocsRoot();
      const error = yield* PlanService.PlanService.use((svc) =>
        svc.read({ threadId: UNBOUND }),
      ).pipe(Effect.flip, Effect.provide(makeLayer(root)));
      assert.instanceOf(error, PlanError);
      assert.strictEqual(error.reason, "not_bound");
    }),
  );

  it.effect("rejects a plan path that escapes the docs root", () =>
    Effect.gen(function* () {
      const root = yield* withDocsRoot();
      const error = yield* PlanService.PlanService.use((svc) =>
        svc.toggleMilestone({ threadId: ESCAPE, id: "M1", done: true }),
      ).pipe(Effect.flip, Effect.provide(makeLayer(root)));
      assert.instanceOf(error, PlanError);
      assert.strictEqual(error.reason, "plan_unreadable");
    }),
  );

  it.effect("rejects an unknown milestone id", () =>
    Effect.gen(function* () {
      const root = yield* withDocsRoot();
      const error = yield* PlanService.PlanService.use((svc) =>
        svc.toggleMilestone({ threadId: BOUND, id: "M9", done: true }),
      ).pipe(Effect.flip, Effect.provide(makeLayer(root)));
      assert.strictEqual(error.reason, "milestone_not_found");
    }),
  );
});
