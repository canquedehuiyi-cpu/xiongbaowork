import { createDatabase } from "../../src/db/client";
import { testDatabaseUrl } from "./database";

// Loaded before the child suite, so local-threads must handle the same state as a later shard file.
const database = createDatabase(testDatabaseUrl(), { max: 1 });
try {
  await database.execute("select 1");
  if (process.env.DATABASE_URL !== undefined) {
    throw new Error("The load-order regression did not remove DATABASE_URL.");
  }
} finally {
  await database.$client.close();
}
