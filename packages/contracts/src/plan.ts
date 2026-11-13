import * as Schema from "effect/Schema";

import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PlanMilestone = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  done: Schema.Boolean,
});
export type PlanMilestone = typeof PlanMilestone.Type;

export const PlanView = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  milestones: Schema.Array(PlanMilestone),
  progressLog: Schema.Array(Schema.String),
});
export type PlanView = typeof PlanView.Type;

export const PlanReadInput = Schema.Struct({ threadId: ThreadId });
export const PlanToggleMilestoneInput = Schema.Struct({
  threadId: ThreadId,
  id: TrimmedNonEmptyString,
  done: Schema.Boolean,
});

export const DriftItem = Schema.Struct({
  rule: TrimmedNonEmptyString,
  message: Schema.String,
  expectedPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type DriftItem = typeof DriftItem.Type;

export const PlanDriftCheckInput = Schema.Struct({ threadId: ThreadId, turnId: RunId });

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  reason: Schema.Literals(["not_bound", "milestone_not_found", "plan_unreadable"]),
  message: Schema.String,
}) {}
