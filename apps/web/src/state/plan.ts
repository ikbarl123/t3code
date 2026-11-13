import { createPlanEnvironmentAtoms } from "@t3tools/client-runtime/state/plan";

import { connectionAtomRuntime } from "../connection/runtime";

export const planEnvironment = createPlanEnvironmentAtoms(connectionAtomRuntime);
