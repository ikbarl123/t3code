import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

const RESULT_LIMIT = 50;
const PATH_ONLY_PENALTY = 1000;

/** Notes matching `query` as a case-insensitive subsequence; filename hits rank above folder hits. */
export function rankNotePaths(
  paths: ReadonlyArray<string>,
  query: string,
  limit: number = RESULT_LIMIT,
): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return paths.slice(0, limit);
  const scored: Array<{ readonly path: string; readonly score: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const nameScore = scoreSubsequenceMatch(name, needle);
    const score =
      nameScore ??
      (() => {
        const pathScore = scoreSubsequenceMatch(lower, needle);
        return pathScore === null ? null : PATH_ONLY_PENALTY + pathScore;
      })();
    if (score !== null) scored.push({ path, score });
  }
  return scored
    .toSorted(
      (a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}
