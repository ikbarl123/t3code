import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN docs_project_id TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN docs_gate TEXT NOT NULL DEFAULT 'warn'`;
});
