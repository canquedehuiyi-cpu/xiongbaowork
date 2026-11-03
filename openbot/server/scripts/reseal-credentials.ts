/**
 * Reseal every unbound (v1) credential envelope into a v2 envelope bound to its own row (audit #9).
 *
 *   bun scripts/reseal-credentials.ts
 *
 * Needs DATABASE_URL (the application role) and KEY_ENCRYPTION_KEY, exactly as the server does. It
 * lists tenants in the platform frame, then reseals each tenant's rows inside that tenant's own
 * frame, writing a row only where its stored value is still the one it read. Safe to run on a live
 * deployment and safe to run again: a resealed row is never touched twice.
 *
 * Prints one JSON line per tenant and a final summary: counts and ids only, never a secret. Exits 0
 * when no unbound row remains, which is when `VAULT_REQUIRE_AAD=1` may be set; exits 1 when some
 * remain (changed during the run, or unreadable with this key), naming why in the summary. Run it
 * again for the first; the second needs a person to look at the rows the output names.
 */
import { loadConfig } from "../src/config";
import { resealCredentials } from "../src/credentials-reseal";
import { createDatabase } from "../src/db/client";
import { reasonWithoutStatement } from "../src/db/query-failure";

const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl, { max: 1 });
let code = 0;
try {
  const report = await resealCredentials(database, config.keyEncryptionKey);
  if (report.remaining > 0) {
    console.error(
      JSON.stringify({
        type: "credential-reseal-incomplete",
        remaining: report.remaining,
        note: "Unbound credential rows remain. Do not set VAULT_REQUIRE_AAD=1 yet: rerun this script, and look at any row reported unreadable.",
      }),
    );
    code = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      type: "credential-reseal-failed",
      reason: reasonWithoutStatement(error),
    }),
  );
  code = 2;
} finally {
  await database.$client.end({ timeout: 5 });
}
process.exit(code);
