import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { requestGuarded } from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

export function createPlanEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    // Guarded tags cannot use createEnvironmentRpcQueryAtomFamily; go through requestGuarded.
    read: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:plan:read",
      staleTimeMs: 5_000,
      execute: (input: { readonly threadId: ThreadId }) =>
        requestGuarded(WS_METHODS.planRead, input),
    }),
    toggleMilestone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan:toggle-milestone",
      tag: WS_METHODS.planToggleMilestone,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }: { environmentId: EnvironmentId; input: { threadId: ThreadId } }) =>
          JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}

