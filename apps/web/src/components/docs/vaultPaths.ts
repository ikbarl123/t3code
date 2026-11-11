import type { ProjectEntry } from "@t3tools/contracts";

// ponytail: the RPC lists one directory per call, so the walk is one call per folder. Upgrade to a server-side recursive list if vaults get large.
export const NOTE_LIMIT = 2000;
const WALK_CONCURRENCY = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

export type ListDirectory = (
  directoryPath: string | undefined,
) => Promise<ReadonlyArray<ProjectEntry>>;

/**
 * Every markdown file under the vault root, breadth-first. Dot entries and node_modules are skipped.
 * A failing root listing throws; a failing subfolder is skipped.
 */
export async function collectMarkdownPaths(
  listDirectory: ListDirectory,
  limit: number = NOTE_LIMIT,
): Promise<string[]> {
  const found: string[] = [];
  let queue: Array<string | undefined> = [undefined];
  while (queue.length > 0 && found.length < limit) {
    const batch = queue.slice(0, WALK_CONCURRENCY);
    queue = queue.slice(WALK_CONCURRENCY);
    const listings = await Promise.all(
      batch.map((directory) =>
        listDirectory(directory).catch((error: unknown) => {
          if (directory === undefined) throw error;
          return [];
        }),
      ),
    );
    for (const entries of listings) {
      for (const entry of entries) {
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        if (name.startsWith(".")) continue;
        if (entry.kind === "directory") {
          if (!SKIPPED_DIRECTORIES.has(name)) queue.push(entry.path);
        } else if (/\.md$/i.test(name)) {
          found.push(entry.path);
        }
      }
    }
  }
  return found.slice(0, limit);
}

/** Maps `items` with at most `concurrency` in flight; results keep input order. */
export async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
