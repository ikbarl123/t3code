import {
  PlanError,
  PlanReadInput,
  PlanToggleMilestoneInput,
  type PlanView,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

const MILESTONE_LINE = /^- \[([ xX])\] \*\*([^*]+)\*\*: (.*)$/;

const frontmatterValue = (lines: ReadonlyArray<string>, key: string) => {
  if (lines[0] !== "---") return "";
  const end = lines.indexOf("---", 1);
  const line = lines.slice(1, end === -1 ? undefined : end).find((l) => l.startsWith(`${key}:`));
  return line === undefined
    ? ""
    : line
        .slice(key.length + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
};

const progressSection = (lines: ReadonlyArray<string>) => {
  const start = lines.indexOf("## Progress Log");
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
  return { start, end };
};

export const parsePlan = (text: string): PlanView => {
  const lines = text.split(/\r?\n/);
  const milestones = lines.flatMap((line) => {
    const match = MILESTONE_LINE.exec(line);
    return match === null ? [] : [{ id: match[2]!, text: match[3]!, done: match[1] !== " " }];
  });
  const section = progressSection(lines);
  const progressLog =
    section === null
      ? []
      : lines
          .slice(section.start + 1, section.end)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2));
  return {
    title: frontmatterValue(lines, "title"),
    status: frontmatterValue(lines, "status"),
    milestones,
    progressLog,
  };
};

/** Returns undefined when the milestone id is absent. Returns `text` unchanged when already in that state. */
/** Edits a plan, preserving CRLF line endings when the file uses them. */
export const setMilestone = (
  text: string,
  id: string,
  done: boolean,
  date: string,
): string | undefined => {
  if (!text.includes("\r\n")) return setMilestoneLf(text, id, done, date);
  const next = setMilestoneLf(text.replace(/\r\n/g, "\n"), id, done, date);
  return next === undefined ? undefined : next.replace(/\n/g, "\r\n");
};

const setMilestoneLf = (
  text: string,
  id: string,
  done: boolean,
  date: string,
): string | undefined => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => MILESTONE_LINE.exec(line)?.[2] === id);
  if (index === -1) return undefined;
  const current = MILESTONE_LINE.exec(lines[index]!)!;
  if ((current[1] !== " ") === done) return text;

  lines[index] = lines[index]!.replace(/^- \[[ xX]\]/, done ? "- [x]" : "- [ ]");
  const entry = `- ${date}: ${id} ${done ? "marked done" : "reopened"} (via UI)`;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    const updated = lines.findIndex((line, i) => i < end && line.startsWith("updated:"));
    if (updated !== -1) lines[updated] = `updated: ${date}`;
  }
  const section = progressSection(lines);
  if (section === null) {
    return `${lines.join("\n").replace(/\n*$/, "")}\n\n## Progress Log\n\n${entry}\n`;
  }
  let insertAt = section.start + 1;
  for (let i = section.start + 1; i < section.end; i++) {
    if (lines[i]!.startsWith("- ")) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, entry);
  return lines.join("\n");
};

export class PlanService extends Context.Service<
  PlanService,
  {
    readonly read: (input: typeof PlanReadInput.Type) => Effect.Effect<PlanView, PlanError>;
    readonly toggleMilestone: (
      input: typeof PlanToggleMilestoneInput.Type,
    ) => Effect.Effect<PlanView, PlanError>;
  }
>()("t3/plan/PlanService") {}

const notBound = (message: string) => new PlanError({ reason: "not_bound", message });
const unreadable = (message: string) => new PlanError({ reason: "plan_unreadable", message });

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const resolvePlan = Effect.fn("PlanService.resolvePlan")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => unreadable("Failed to load thread.")));
    if (shell === null || !shell.planPath) return yield* notBound("Thread has no bound plan.");
    const planPath = shell.planPath;
    // Absolute and `~` paths would read or write host files outside the docs project.
    if (
      path.isAbsolute(planPath) ||
      planPath.startsWith("~") ||
      planPath.split(/[\\/]/).includes("..")
    ) {
      return yield* unreadable(`Plan path escapes the docs project: ${planPath}`);
    }
    const project = yield* projects
      .getById(shell.projectId)
      .pipe(Effect.mapError(() => unreadable("Failed to load project.")));
    const docsProjectId = Option.isSome(project) ? project.value.docsProjectId : null;
    if (!docsProjectId) return yield* notBound("Project has no docs project.");
    const docs = yield* projects
      .getById(docsProjectId)
      .pipe(Effect.mapError(() => unreadable("Failed to load docs project.")));
    if (Option.isNone(docs)) return yield* notBound("Docs project not found.");
    return { cwd: docs.value.workspaceRoot, planPath };
  });

  const readText = Effect.fn("PlanService.readText")(function* (cwd: string, relativePath: string) {
    const file = yield* workspaceFileSystem
      .readFile({ cwd, relativePath })
      .pipe(Effect.mapError(() => unreadable(`Plan unreadable: ${relativePath}`)));
    if (file.truncated) return yield* unreadable(`Plan too large: ${relativePath}`);
    return file.contents;
  });

  const read: PlanService["Service"]["read"] = Effect.fn("PlanService.read")(function* (input) {
    const { cwd, planPath } = yield* resolvePlan(input.threadId);
    return parsePlan(yield* readText(cwd, planPath));
  });

  // Serializes toggles in this process; agent edits are still guarded by compare-before-write below.
  const writeLock = yield* Semaphore.make(1);

  const toggleMilestone: PlanService["Service"]["toggleMilestone"] = Effect.fn(
    "PlanService.toggleMilestone",
  )(function* (input) {
    const { cwd, planPath } = yield* resolvePlan(input.threadId);
    return yield* writeLock.withPermits(1)(update(cwd, planPath, input));
  });

  const update = Effect.fn("PlanService.update")(function* (
    cwd: string,
    planPath: string,
    input: PlanToggleMilestoneInput,
  ) {
    const text = yield* readText(cwd, planPath);
    const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
    const next = setMilestone(text, input.id, input.done, date);
    if (next === undefined) {
      return yield* new PlanError({
        reason: "milestone_not_found",
        message: `Milestone ${input.id} not found in ${planPath}.`,
      });
    }
    if (next !== text) {
      // ponytail: compare-before-write narrows the race with agent edits but is not atomic; add a keyed lock if toggles contend.
      if ((yield* readText(cwd, planPath)) !== text) {
        return yield* unreadable(`Plan changed while updating: ${planPath}. Retry.`);
      }
      yield* workspaceFileSystem
        .writeFile({ cwd, relativePath: planPath, contents: next })
        .pipe(Effect.mapError(() => unreadable(`Plan write failed: ${planPath}`)));
    }
    return parsePlan(next);
  });

  return PlanService.of({ read, toggleMilestone });
});

export const layer = Layer.effect(PlanService, make);
