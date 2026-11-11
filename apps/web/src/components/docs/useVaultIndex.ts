import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useSyncExternalStore } from "react";

import { projectEnvironment } from "~/state/projects";
import { buildLinkIndex, type LinkIndex, type NoteInput } from "./backlinks";
import { collectMarkdownPaths, mapConcurrent, NOTE_LIMIT, type ListDirectory } from "./vaultPaths";

export type VaultStatus = "loading" | "indexing" | "ready" | "error";

export interface VaultSnapshot {
  /** Usable as soon as the folder walk finishes; `index` follows once every note is read. */
  readonly paths: ReadonlyArray<string>;
  readonly index: LinkIndex | null;
  readonly status: VaultStatus;
}

export interface VaultIndexView extends VaultSnapshot {
  readonly refresh: () => void;
}

const READ_CONCURRENCY = 8;
const EMPTY_SNAPSHOT: VaultSnapshot = { paths: [], index: null, status: "loading" };

// Per vault, so every mount of the docs page shares one scan. Module-level on purpose.
const snapshots = new Map<string, VaultSnapshot>();
const generations = new Map<string, number>();
const loadedAt = new Map<string, number>();
// ponytail: focus rescans only once the cached index is this old; manual refresh() always rescans.
const FOCUS_RESCAN_MS = 60_000;
const listeners = new Set<() => void>();

const keyOf = (environmentId: EnvironmentId, cwd: string) => `${environmentId}:${cwd}`;

function publish(key: string, next: VaultSnapshot) {
  snapshots.set(key, next);
  for (const listener of listeners) listener();
}

async function atomValue<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Parameters<typeof executeAtomQuery<A, E>>[1],
) {
  const result = await executeAtomQuery(registry, atom, { refresh: true, reportFailure: false });
  return AsyncResult.isSuccess(result) ? result.value : null;
}

async function loadVault(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
) {
  const key = keyOf(environmentId, cwd);
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const isCurrent = () => generations.get(key) === generation;
  // A superseded scan stops issuing RPC reads, not just stops publishing.
  const readIfCurrent = <A, E>(atom: Parameters<typeof executeAtomQuery<A, E>>[1]) =>
    isCurrent() ? atomValue(registry, atom) : Promise.resolve(null);
  const previous = snapshots.get(key) ?? EMPTY_SNAPSHOT;
  publish(key, { ...previous, status: "loading" });

  const listDirectory: ListDirectory = async (directoryPath) => {
    const listing = await readIfCurrent(
      projectEnvironment.listEntries({
        environmentId,
        input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
      }),
    );
    if (listing === null) throw new Error("Could not list the vault.");
    return listing.entries;
  };

  let paths: string[];
  try {
    paths = await collectMarkdownPaths(listDirectory, NOTE_LIMIT);
  } catch {
    if (isCurrent()) publish(key, { ...previous, status: "error" });
    return;
  }
  if (!isCurrent()) return;
  // ponytail: a note that fails to read is dropped from the index instead of retried.
  publish(key, { paths, index: null, status: "indexing" });

  const texts = await mapConcurrent(paths, READ_CONCURRENCY, async (path) => {
    const file = await readIfCurrent(
      projectEnvironment.readFile({
        environmentId,
        input: { cwd, relativePath: path, allowMissing: true },
      }),
    );
    return file?.exists === false || file === null
      ? null
      : ({ path, text: file.contents } as const);
  });
  if (!isCurrent()) return;
  loadedAt.set(key, Date.now());
  const notes = texts.filter((note): note is NoteInput => note !== null);
  publish(key, { paths, index: buildLinkIndex(notes), status: "ready" });
}

/**
 * Vault paths and link index for one docs project. Paths appear before the index is built;
 * the cached snapshot survives remounts and is reloaded on window focus or `refresh()`.
 */
export function useVaultIndex(environmentId: EnvironmentId, cwd: string | null): VaultIndexView {
  const registry = useContext(RegistryContext);
  const key = cwd === null ? null : keyOf(environmentId, cwd);
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key === null ? EMPTY_SNAPSHOT : (snapshots.get(key) ?? EMPTY_SNAPSHOT)),
  );

  const refresh = () => {
    if (cwd !== null) void loadVault(registry, environmentId, cwd);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the vault scan for an external RPC source and reloads it on window focus; the scan itself runs outside React.
  useEffect(() => {
    if (cwd === null) return;
    if (!snapshots.has(keyOf(environmentId, cwd))) void loadVault(registry, environmentId, cwd);
    const onFocus = () => {
      const age = Date.now() - (loadedAt.get(keyOf(environmentId, cwd)) ?? 0);
      if (age >= FOCUS_RESCAN_MS) void loadVault(registry, environmentId, cwd);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [registry, environmentId, cwd]);

  return { ...snapshot, refresh };
}
