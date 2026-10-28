import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { userRoles, users } from "../db/schema";

export type OpenBotRole = "admin" | "user";

/** A binding is installed only after both actual database roles have been inspected. */
type RoleWriterState = {
  writer: Database;
  closing: boolean;
  pending: Set<Promise<void>>;
  finishing: Promise<void> | null;
};
const roleWriters = new WeakMap<Database, RoleWriterState>();
const roleWriterInitializations = new WeakSet<Database>();

export async function initializeRoleWriter(
  application: Database,
  writer: Database,
): Promise<void> {
  if (
    application === writer ||
    roleWriters.has(application) ||
    roleWriterInitializations.has(application)
  ) {
    throw new Error("A distinct role writer must be initialized exactly once.");
  }
  roleWriterInitializations.add(application);
  try {
    const factsQuery = sql`
    SELECT current_user AS role, session_user AS session_role,
      (SELECT a.usename FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_backend_pid()) AS login_role,
      current_database() AS database,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
      inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
      r.rolsuper AS super, r.rolbypassrls AS bypass, r.rolcanlogin AS can_login,
      r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
      r.rolinherit AS inherits,
      EXISTS (SELECT 1 FROM pg_catalog.pg_database d
        WHERE d.datname = current_database() AND d.datdba = r.oid) AS owns_database,
      EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
        WHERE n.nspname = 'public' AND n.nspowner = r.oid) AS owns_public_schema,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proowner = r.oid
          AND left(p.proname, 16) = 'plugin_assembly_') AS owns_authority_function,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proowner = r.oid) AS owns_public_function,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relowner = r.oid
          AND c.relname IN ('user_roles','mcp_servers','mcp_tools','skills','skill_tools',
            'plugin_assembly_origins','plugin_assembly_publications')
      ) AS owns_authority_table,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relowner = r.oid
      ) AS owns_public_relation,
      has_any_column_privilege(current_user, 'public.user_roles', 'INSERT,UPDATE,REFERENCES') AS role_column_writes,
      has_any_column_privilege(current_user, 'public.user_roles', 'UPDATE,REFERENCES') AS other_role_column_rights,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS member_of_role,
      has_table_privilege(current_user, 'public.user_roles', 'SELECT') AS reads_roles,
      has_table_privilege(current_user, 'public.user_roles', 'INSERT') AS inserts_roles,
      has_table_privilege(current_user, 'public.user_roles', 'DELETE') AS deletes_roles,
      has_table_privilege(current_user, 'public.user_roles', 'UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS other_role_rights,
      has_table_privilege(current_user, 'public.user_roles', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,DELETE WITH GRANT OPTION') AS role_grant_options,
      has_any_column_privilege(current_user, 'public.user_roles', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS role_column_grant_options,
      has_table_privilege(current_user, 'public.user_roles', 'UPDATE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION,MAINTAIN WITH GRANT OPTION') AS other_role_grant_options,
      has_any_column_privilege(current_user, 'public.user_roles', 'UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') AS other_role_column_grant_options,
      has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION,USAGE WITH GRANT OPTION') AS schema_grant_options,
      has_database_privilege(current_user, current_database(), 'CREATE WITH GRANT OPTION,CONNECT WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION') AS database_grant_options,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.oid <> 'public.user_roles'::regclass
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN (
              has_table_privilege(current_user, c.oid, 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION,MAINTAIN WITH GRANT OPTION')
              OR has_any_column_privilege(current_user, c.oid, 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
            )
            WHEN c.relkind = 'S' THEN has_sequence_privilege(current_user, c.oid, 'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
            ELSE false END
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND has_function_privilege(current_user, p.oid, 'EXECUTE WITH GRANT OPTION')
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND has_type_privilege(current_user, t.oid, 'USAGE WITH GRANT OPTION')
      ) AS other_public_grant_options,
      has_schema_privilege(current_user, 'public', 'CREATE') AS creates_public,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND c.oid <> 'public.user_roles'::regclass
          AND (
            has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          )
      ) AS other_public_rights
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
  `;
    const [appFacts] = await application.execute(factsQuery);
    const [writerFacts] = await writer.execute(factsQuery);
    if (
      !appFacts ||
      !writerFacts ||
      appFacts.role === "openbot_role_writer" ||
      appFacts.session_role !== appFacts.role ||
      appFacts.login_role !== appFacts.role ||
      appFacts.can_login !== true ||
      appFacts.super !== false ||
      appFacts.bypass !== false ||
      appFacts.create_role !== false ||
      appFacts.create_database !== false ||
      appFacts.member_of_role !== false ||
      appFacts.role_column_writes !== false ||
      appFacts.owns_authority_table !== false ||
      appFacts.owns_authority_function !== false ||
      appFacts.owns_database !== false ||
      appFacts.owns_public_schema !== false ||
      appFacts.inserts_roles !== false ||
      appFacts.deletes_roles !== false ||
      appFacts.other_role_rights !== false ||
      appFacts.role_grant_options !== false ||
      appFacts.role_column_grant_options !== false ||
      appFacts.other_role_grant_options !== false ||
      appFacts.other_role_column_grant_options !== false ||
      appFacts.schema_grant_options !== false ||
      appFacts.database_grant_options !== false ||
      appFacts.other_public_grant_options !== false ||
      appFacts.reads_roles !== true ||
      writerFacts.role !== "openbot_role_writer" ||
      writerFacts.session_role !== "openbot_role_writer" ||
      writerFacts.login_role !== "openbot_role_writer" ||
      writerFacts.can_login !== true ||
      writerFacts.super !== false ||
      writerFacts.bypass !== false ||
      writerFacts.create_role !== false ||
      writerFacts.create_database !== false ||
      writerFacts.inherits !== false ||
      writerFacts.member_of_role !== false ||
      writerFacts.owns_public_relation !== false ||
      writerFacts.owns_public_function !== false ||
      writerFacts.owns_database !== false ||
      writerFacts.owns_public_schema !== false ||
      writerFacts.reads_roles !== true ||
      writerFacts.inserts_roles !== true ||
      writerFacts.deletes_roles !== true ||
      writerFacts.other_role_rights !== false ||
      writerFacts.role_grant_options !== false ||
      writerFacts.role_column_grant_options !== false ||
      writerFacts.other_role_grant_options !== false ||
      writerFacts.other_role_column_grant_options !== false ||
      writerFacts.schema_grant_options !== false ||
      writerFacts.database_grant_options !== false ||
      writerFacts.other_public_grant_options !== false ||
      writerFacts.other_role_column_rights !== false ||
      writerFacts.creates_public !== false ||
      writerFacts.other_public_rights !== false ||
      typeof appFacts.database !== "string" ||
      typeof appFacts.database_oid !== "string" ||
      typeof appFacts.server_address !== "string" ||
      typeof appFacts.server_port !== "number" ||
      appFacts.database !== writerFacts.database ||
      appFacts.database_oid !== writerFacts.database_oid ||
      appFacts.server_address !== writerFacts.server_address ||
      appFacts.server_port !== writerFacts.server_port
    ) {
      throw new Error(
        "The database role writer does not satisfy its restricted authority contract.",
      );
    }
    const [membership] = await application.execute(sql`
    SELECT pg_has_role(current_user, 'openbot_role_writer', 'MEMBER') AS writer_member
  `);
    if (membership?.writer_member !== false) {
      throw new Error(
        "The application must not be a member of the database role writer.",
      );
    }
    roleWriters.set(application, {
      writer,
      closing: false,
      pending: new Set(),
      finishing: null,
    });
  } finally {
    roleWriterInitializations.delete(application);
  }
}

/** Seal new writes synchronously, then join every already-admitted write without swallowing errors. */
export function stopRoleWriter(application: Database): Promise<void> {
  const state = roleWriters.get(application);
  if (!state)
    return Promise.reject(
      new Error("The database role writer is not initialized."),
    );
  if (state.finishing) return state.finishing;
  state.closing = true;
  state.finishing = (async () => {
    const results = await Promise.allSettled([...state.pending]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        "Role writes did not settle successfully.",
      );
  })();
  return state.finishing;
}

/** Shared with publication: serialize role revocation with the last current-role admission. */
export async function lockRoleAuthority(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  userId: string,
): Promise<void> {
  await transaction.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`openbot.role-authority:${userId}`}, 0))
  `);
}

/**
 * Whether this address is an administrator by configuration.
 *
 * A floor, not the whole answer. Somebody named here is always an administrator and cannot be
 * demoted from the admin screen, which is what makes it the way back in when the last administrator
 * demotes themselves by accident. Everybody else's role is whatever an administrator has set.
 */
export function isConfiguredAdmin(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  );
}

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): OpenBotRole {
  return isConfiguredAdmin(email, initialAdminEmails) ? "admin" : "user";
}

/**
 * Give somebody exactly one role.
 *
 * `user_roles` is a set with a `(user_id, role)` primary key and the guard takes `admin` if any row
 * says so, so setting a role means removing the rows that should not be there rather than only
 * inserting one. Both statements inside one transaction: between them a request arriving on another
 * process would find no role at all and be refused with a 403 that reads as a permissions bug.
 */
export async function setRole(
  database: Database,
  userId: string,
  role: OpenBotRole,
): Promise<OpenBotRole> {
  const state = roleWriters.get(database);
  if (!state) throw new Error("The database role writer is not initialized.");
  if (state.closing) throw new Error("The database role writer is closing.");
  const work = state.writer.transaction(async (tx) => {
    await lockRoleAuthority(tx, userId);
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), ne(userRoles.role, role)));
    await tx.insert(userRoles).values({ userId, role }).onConflictDoNothing();
  });
  state.pending.add(work);
  try {
    await work;
  } finally {
    state.pending.delete(work);
  }
  return role;
}

/**
 * The role a brand-new account starts with.
 *
 * The only moment configuration decides somebody who is not on the list: from here on that person's
 * role belongs to whoever administers the deployment.
 */
export async function seedRole(
  database: Database,
  userId: string,
  email: string,
  initialAdminEmails: readonly string[],
): Promise<OpenBotRole> {
  return setRole(database, userId, roleForEmail(email, initialAdminEmails));
}

/**
 * Re-apply the configured floor, on every sign-in.
 *
 * Only ever promotes, and only for an address the deployment names. Somebody added to the list
 * after they first signed in becomes an administrator at their next sign-in, which is the trap this
 * exists to close: the role used to be written once at account creation, so editing the list did
 * nothing at all and no screen could fix it.
 *
 * Everybody else is left exactly as they are, because their role is the admin screen's to decide and
 * a sign-in that overwrote it would make that screen lie the moment they came back.
 *
 * Answers whether this call is what granted the role, so the caller can put that on the audit trail.
 * Anybody who can edit the configuration can make themselves an administrator, and until this
 * returned something there was no row anywhere saying it had happened.
 */
export async function applyConfiguredAdmin(
  database: Database,
  userId: string,
  initialAdminEmails: readonly string[],
): Promise<boolean> {
  // Nothing configured cannot promote anybody, so there is no reason to read the user back.
  if (initialAdminEmails.length === 0) return false;

  const [user] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // No user means a session is being made for somebody who is not there, which is not this module's
  // to report: Better Auth is about to fail on its own and would only be given a worse message here.
  if (!user) return false;

  if (!isConfiguredAdmin(user.email, initialAdminEmails)) return false;

  const [already] = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin")))
    .limit(1);

  await setRole(database, userId, "admin");

  // Whether this sign-in is what granted it. The caller writes an audit row when it did, and a
  // returning administrator must not produce one on every sign-in.
  return !already;
}
