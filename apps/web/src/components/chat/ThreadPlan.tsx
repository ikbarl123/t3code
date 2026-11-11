import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PlanMilestone,
  PlanView,
  ProjectEntry,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { BookOpenIcon } from "lucide-react";

import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useProject, useThreadShell } from "../../state/entities";
import { planEnvironment } from "../../state/plan";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

const PLANS_DIRECTORY = "docs/plans";
const PROGRESS_TAIL_LENGTH = 5;

function isBindablePlan(entry: ProjectEntry): boolean {
  if (entry.kind !== "file" || !entry.path.endsWith(".md")) return false;
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  return name !== "INDEX.md" && name !== "_template.md";
}

function planLabel(planPath: string): string {
  return planPath.slice(planPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

export function PlanChecklist({
  milestones,
  progressLog,
  onToggle,
}: {
  readonly milestones: ReadonlyArray<PlanMilestone>;
  readonly progressLog: ReadonlyArray<string>;
  readonly onToggle: (id: string, done: boolean) => void;
}) {
  const doneCount = milestones.filter((milestone) => milestone.done).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs tabular-nums">
        {doneCount} of {milestones.length} done
      </p>
      <ul className="flex flex-col gap-2">
        {milestones.map((milestone) => (
          <li key={milestone.id} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              aria-label={milestone.text}
              checked={milestone.done}
              onCheckedChange={(checked) => onToggle(milestone.id, checked)}
            />
            <span className={milestone.done ? "text-muted-foreground line-through" : undefined}>
              <span className="font-mono text-xs">{milestone.id}</span> {milestone.text}
            </span>
          </li>
        ))}
      </ul>
      {progressLog.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-muted-foreground text-xs font-medium">Progress log</h4>
          <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
            {progressLog.slice(-PROGRESS_TAIL_LENGTH).map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function BoundPlan({
  environmentId,
  threadId,
  planPath,
  onUnbind,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly planPath: string;
  readonly onUnbind: () => void;
}) {
  const readInput = { environmentId, input: { threadId } };
  const readAtom = planEnvironment.read(readInput);
  const result = useAtomValue(readAtom);
  const refresh = useAtomRefresh(readAtom);
  const toggleMilestone = useOrchestrationCommand(planEnvironment.toggleMilestone, {
    reportFailure: false,
  });
  const plan: PlanView | null = AsyncResult.getOrElse(result, () => null);

  const onToggle = (id: string, done: boolean) => {
    void toggleMilestone({ environmentId, input: { threadId, id, done } }).then((outcome) => {
      if (isAtomCommandInterrupted(outcome)) return;
      if (outcome._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Failed to update milestone",
          description: String(squashAtomCommandFailure(outcome)),
        });
        return;
      }
      refresh();
    });
  };

  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-sm">{plan?.title ?? planLabel(planPath)}</h3>
        <p className="font-mono text-muted-foreground text-xs">{planPath}</p>
      </div>
      {plan === null ? (
        <p
          className="text-muted-foreground text-xs"
          role={AsyncResult.isFailure(result) ? "alert" : undefined}
        >
          {AsyncResult.isFailure(result) ? "Could not read this plan." : "Loading plan…"}
        </p>
      ) : (
        <PlanChecklist
          milestones={plan.milestones}
          progressLog={plan.progressLog}
          onToggle={onToggle}
        />
      )}
      <Button size="sm" variant="ghost-muted" onClick={onUnbind}>
        Unbind plan
      </Button>
    </div>
  );
}

function PlanPicker({
  environmentId,
  docsRoot,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly docsRoot: string;
  readonly onPick: (planPath: string) => void;
}) {
  const entries = useAtomValue(
    projectEnvironment.listEntries({
      environmentId,
      input: { cwd: docsRoot, directoryPath: PLANS_DIRECTORY },
    }),
  );
  const plans = (AsyncResult.getOrElse(entries, () => null)?.entries ?? []).filter(isBindablePlan);
  return (
    <div className="flex w-64 flex-col gap-2">
      <h3 className="font-medium text-sm">Bind plan</h3>
      {AsyncResult.isSuccess(entries) && plans.length === 0 ? (
        <p className="text-muted-foreground text-xs">No plans in {PLANS_DIRECTORY}.</p>
      ) : null}
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {plans.map((entry) => (
          <li key={entry.path}>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => onPick(entry.path)}
            >
              {planLabel(entry.path)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Thread header chip for the vault plan bound to a thread. Renders nothing without a docs project. */
export function ThreadPlanControl({
  environmentId,
  threadId,
  docsProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly docsProjectId: ProjectId | null | undefined;
}) {
  const docsProject = useProject(
    docsProjectId ? scopeProjectRef(environmentId, docsProjectId) : null,
  );
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const bindPlan = useOrchestrationCommand(threadEnvironment.bindPlan, { reportFailure: false });
  const unbindPlan = useOrchestrationCommand(threadEnvironment.unbindPlan, {
    reportFailure: false,
  });
  if (!docsProjectId || docsProject === null) return null;

  const planPath = shell?.planPath ?? null;
  const docsRoot = docsProject.workspaceRoot;

  const reportBindFailure = (title: string) => (outcome: { readonly _tag: string }) => {
    if (isAtomCommandInterrupted(outcome as never) || outcome._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(outcome as never)),
    });
  };
  const pick = (nextPath: string) => {
    void bindPlan({ environmentId, input: { threadId, planPath: nextPath } }).then(
      reportBindFailure("Failed to bind plan"),
    );
  };
  const unbind = () => {
    void unbindPlan({ environmentId, input: { threadId } }).then(
      reportBindFailure("Failed to unbind plan"),
    );
  };

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex min-w-0 max-w-48 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={planPath ? `Plan: ${planLabel(planPath)}` : "Bind plan"}
      >
        <BookOpenIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{planPath ? planLabel(planPath) : "Bind plan"}</span>
      </PopoverTrigger>
      <PopoverPopup align="start" padding="default">
        {planPath ? (
          <BoundPlan
            environmentId={environmentId}
            threadId={threadId}
            planPath={planPath}
            onUnbind={unbind}
          />
        ) : (
          <PlanPicker environmentId={environmentId} docsRoot={docsRoot} onPick={pick} />
        )}
      </PopoverPopup>
    </Popover>
  );
}
