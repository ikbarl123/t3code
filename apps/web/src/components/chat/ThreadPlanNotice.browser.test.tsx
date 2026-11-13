import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { noPlanBannerItem } from "./ThreadPlan";

const DOCS_PROJECT_ID = "docs-project" as never;
const CHECKPOINT = {
  checkpointTurnCount: 1,
  checkpointRef: "ref" as never,
  runId: "run" as never,
  status: "ready",
  files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
  assistantMessageId: null,
  completedAt: "2026-11-11T00:00:00.000Z",
} as const;

function notice(overrides: Partial<Parameters<typeof noPlanBannerItem>[0]> = {}) {
  const item = noPlanBannerItem({
    docsProjectId: DOCS_PROJECT_ID,
    docsGate: "warn",
    planPath: null,
    checkpoints: [CHECKPOINT as never],
    onBind: () => {},
    onDismiss: () => {},
    ...overrides,
  });
  return <ComposerBannerStack items={item ? [item] : []} />;
}

it("shows a status notice when code changed on an unbound thread in a docs project", async () => {
  await using screen = await render(notice());
  await expect
    .element(screen.getByText("No plan bound to this thread. Bind one to keep docs in sync."))
    .toBeInTheDocument();
  await expect.element(screen.getByRole("status")).toBeInTheDocument();
});

it("stays hidden when the thread has a plan bound", async () => {
  await using screen = await render(notice({ planPath: "docs/plans/x.md" }));
  expect(screen.container.querySelector("[role=status]")).toBeNull();
});

it("stays hidden when the docs gate is off", async () => {
  await using screen = await render(notice({ docsGate: "off" }));
  expect(screen.container.querySelector("[role=status]")).toBeNull();
});

it("stays hidden without a docs project", async () => {
  await using screen = await render(notice({ docsProjectId: null }));
  expect(screen.container.querySelector("[role=status]")).toBeNull();
});

it("stays hidden before any turn changed files", async () => {
  await using screen = await render(
    notice({ checkpoints: [{ ...CHECKPOINT, files: [] } as never] }),
  );
  expect(screen.container.querySelector("[role=status]")).toBeNull();
});
