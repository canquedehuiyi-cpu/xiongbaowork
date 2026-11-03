import { createDatabase } from "../../src/db/client";
import { runAsTenant } from "../../src/tenant/context";
import { testDatabaseUrl } from "./database";

// Loaded before the child suite, so local-threads must handle the same state as a later shard file.
const database = createDatabase(testDatabaseUrl(), { max: 1 });
try {
  // Nobody's question, so asked as `platform`: unframed, this preload would be the first offender
  // the tenant frame guard reports for every shard (G01-D).
  await runAsTenant("platform", () => database.execute("select 1"));
  if (process.env.DATABASE_URL !== undefined) {
    throw new Error("The load-order regression did not remove DATABASE_URL.");
  }
} finally {
  await database.$client.close();
}
