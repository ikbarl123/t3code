import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { planEnvironment } from "../state/plan";

function DriftItems({
  environmentId,
  threadId,
  turnId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: RunId;
}) {
  const result = useAtomValue(
    planEnvironment.driftCheck({ environmentId, input: { threadId, turnId } }),
  );
  const items = AsyncResult.getOrElse(result, () => null);
  if (AsyncResult.isFailure(result)) {
    return (
      <p role="alert" className="text-destructive-foreground text-xs">
        Could not check docs drift.
      </p>
    );
  }
  if (items === null) return <p className="text-muted-foreground text-xs">Checking docs…</p>;
  if (items.length === 0) return <p className="text-muted-foreground text-xs">No drift.</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {items.map((item) => (
        <li key={item.rule}>
          <span>{item.message}</span>
          {item.expectedPath ? (
            <span className="ml-1 font-mono text-muted-foreground">{item.expectedPath}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Non-blocking. Collapsed by default, and the drift RPC runs only once expanded. */
export function DocsDriftSection({
  environmentId,
  threadId,
  turnId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: RunId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-b border-border/70 px-3 py-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        Docs drift
      </button>
      {open ? (
        <div className="mt-1.5">
          <DriftItems environmentId={environmentId} threadId={threadId} turnId={turnId} />
        </div>
      ) : null}
    </div>
  );
}
