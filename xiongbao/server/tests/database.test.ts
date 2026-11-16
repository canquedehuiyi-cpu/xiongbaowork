import { expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL } from "./support/database";

test("creates a typed database boundary without opening a query", async () => {
  const database = createDatabase(
    "postgres://openbot:openbot@localhost:5432/openbot",
    TEST_POOL,
  );

  // The deployment's schema, not anybody's rows: asked from the platform frame.
  expect(runAsTenant("platform", () => database.query.users)).toBeDefined();
  await database.$client.close();
});
