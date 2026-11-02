/**
 * Grant the administrator role to one existing account, from the server's own shell.
 *
 * `INITIAL_ADMIN_EMAILS` only promotes an address something has verified: an identity provider, or
 * an SSO connection an administrator registered. A password sign-up is verified by nobody, so a
 * listed address registered with a password is whoever typed it first and is never promoted. A
 * deployment that signs people in with passwords alone therefore needs another way to name its first
 * administrator, and this is it: whoever can run a command inside the server already holds the
 * database and every secret, so their word is the strongest one available.
 *
 *   bun scripts/grant-admin.ts admin@example.com
 *
 * Needs DATABASE_URL (the application role) and ROLE_WRITER_DATABASE_URL (the only role allowed to
 * write identity roles), exactly as the server does. Writes an audit row saying who was promoted and
 * that the deployment, not a person in the product, did it.
 */
import { eq, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../src/audit";
import {
  initializeRoleWriter,
  setRole,
  stopRoleWriter,
} from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";

const email = process.argv[2]?.trim().toLowerCase();
if (!email?.includes("@")) {
  console.error(
    "Usage: bun scripts/grant-admin.ts <email of an existing account>",
  );
  process.exit(2);
}
const applicationUrl = process.env.DATABASE_URL;
const writerUrl = process.env.ROLE_WRITER_DATABASE_URL;
if (!applicationUrl || !writerUrl) {
  console.error("DATABASE_URL and ROLE_WRITER_DATABASE_URL must both be set.");
  process.exit(2);
}

const application = createDatabase(applicationUrl, { max: 1 });
const writer = createDatabase(writerUrl, { max: 1 });
let code = 0;
try {
  const [user] = await application
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  if (!user) {
    console.error(
      `No account has the address ${email}. Sign up first, then run this again.`,
    );
    code = 1;
  } else {
    await initializeRoleWriter(application, writer);
    try {
      await setRole(application, user.id, "admin");
    } finally {
      await stopRoleWriter(application);
    }
    await recordAuditEvent(createAuditStore(application), {
      eventType: "person.admin_by_configuration",
      targetType: "person",
      targetId: user.id,
      initiator: { kind: "deployment" },
      payload: {
        email: user.email,
        reason: "granted from the server shell with scripts/grant-admin.ts",
      },
    });
    console.info(JSON.stringify({ type: "admin-granted", userId: user.id }));
  }
} finally {
  await application.$client.end({ timeout: 5 });
  await writer.$client.end({ timeout: 5 });
}
process.exit(code);
