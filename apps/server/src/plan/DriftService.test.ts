// @effect-diagnostics nodeBuiltinImport:off -- node:fs/path used for temp fixtures
import { assert, describe, it } from "@effect/vitest";
import { matchesGlob } from "node:path";

import {
  changedPathsFromPatch,
  DEFAULT_RULES,
  evaluateRules,
  rulesFromConfig,
  type DocsSyncRule,
} from "./DriftService.ts";

const matches = (candidate: string, pattern: string) => matchesGlob(candidate, pattern);

const fixtureRules: ReadonlyArray<DocsSyncRule> = [
  { id: "ddl", when: "src/db/**", expect: "docs/ddl/**", message: "ddl" },
];

describe("DriftService", () => {
  it("flags a rule when its trigger changed without the expected path", () => {
    const items = evaluateRules(fixtureRules, ["src/db/a.ts"], matches);
    assert.deepStrictEqual(items, [{ rule: "ddl", message: "ddl", expectedPath: "docs/ddl/**" }]);
  });

  it("is quiet when the expected path also changed", () => {
    assert.deepStrictEqual(
      evaluateRules(fixtureRules, ["src/db/a.ts", "docs/ddl/x.md"], matches),
      [],
    );
  });

  it("is quiet when no trigger matched", () => {
    assert.deepStrictEqual(evaluateRules(fixtureRules, ["src/ui/a.ts"], matches), []);
  });

  it("applies the default migration and feature rules", () => {
    const migration = evaluateRules(
      DEFAULT_RULES,
      ["apps/server/src/persistence/Migrations/1.ts"],
      matches,
    );
    // A migration also sits under apps/*/src, so the feature rule fires too; both are expected.
    assert.include(
      migration.map((item) => item.rule),
      "migration-ddl",
    );
    const feature = evaluateRules(
      DEFAULT_RULES,
      ["apps/web/src/a.tsx", "packages/shared/src/b.ts"],
      matches,
    );
    assert.deepStrictEqual(
      feature.map((item) => item.rule),
      ["feature-doc"],
    );
  });

  it("falls back to defaults on missing or malformed docs-sync.json", () => {
    assert.strictEqual(rulesFromConfig(null), DEFAULT_RULES);
    assert.strictEqual(rulesFromConfig("{not json"), DEFAULT_RULES);
    assert.strictEqual(rulesFromConfig('{"rules":[{"id":1}]}'), DEFAULT_RULES);
  });

  it("parses rules from a config file", () => {
    const text = JSON.stringify({ rules: fixtureRules });
    assert.deepStrictEqual(rulesFromConfig(text), fixtureRules);
  });

  it("extracts changed paths from a git patch", () => {
    const patch = [
      "diff --git a/src/db/a.ts b/src/db/a.ts",
      "--- a/src/db/a.ts",
      "+++ b/src/db/a.ts",
      "diff --git a/docs/ddl/x.md b/docs/ddl/x.md",
    ].join("\n");
    assert.deepStrictEqual(changedPathsFromPatch(patch), ["src/db/a.ts", "docs/ddl/x.md"]);
  });

  it("includes the source path of a rename", () => {
    const patch = "diff --git a/migrations/001.ts b/archive/001.ts\nsimilarity index 100%";
    assert.deepStrictEqual(changedPathsFromPatch(patch), ["migrations/001.ts", "archive/001.ts"]);
  });
});
