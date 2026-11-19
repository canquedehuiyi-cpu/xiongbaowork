/**
 * Whether the role the server connected as can actually be governed by row level security.
 *
 * Spec D15 promises two independent layers, "either one failing, the other still holds". The first
 * of those layers is PostgreSQL policies, and it silently does nothing when the session's role is a
 * superuser or carries `BYPASSRLS` — `FORCE ROW LEVEL SECURITY` binds a table's owner, and nothing
 * binds a superuser. A deployment can therefore be configured exactly as documented, pass every
 * isolation test written against a non-privileged role, and enforce nothing in production. No query
 * fails, no warning appears, and no log line says so: the failure mode is a working server.
 *
 * This module is the verdict only. Deciding it is a pure function over two flags so the truth table
 * is testable without a database, and so the caller — which knows whether this deployment would
 * rather refuse to start or start and shout — cannot accidentally become the place the rules live.
 */
export type RoleFacts = {
  /** The connected role, as the server reports it. Carried for the message, not the decision. */
  role: string;
  super: boolean;
  bypassesRls: boolean;
};

export type RlsVerdict =
  | { enforced: true }
  | {
      enforced: false;
      /** Why, in the sentence a person reads at boot. */
      reason: string;
      /** What to do about it, named rather than hinted at. */
      fix: string;
    };

export function judgeRlsEnforcement(facts: RoleFacts): RlsVerdict {
  if (!facts.super && !facts.bypassesRls) return { enforced: true };
  // Both attributes are reported when both are present: an operator who sees "superuser" fixes the
  // connection string, and one who sees "BYPASSRLS" knows a role was granted a side door rather
  // than being used by accident. The two have different repairs, and naming only the first would
  // send the second person looking for the wrong thing.
  const because = [
    facts.super ? `${facts.role} is a superuser` : null,
    facts.bypassesRls ? `${facts.role} holds BYPASSRLS` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  return {
    enforced: false,
    reason: `row level security does not apply to this connection: ${because}`,
    fix: "run the server as the application role (openbot_app). The owner role is for migrations and the test-database reset, which are the only places that legitimately need it.",
  };
}

/**
 * What to ask the database for.
 *
 * `rolsuper`/`rolbypassrls` rather than `usesuper` from `pg_user`: the view exists on every supported
 * version, and it is the catalog that decides enforcement, so reading it keeps this check answering
 * the same question the server asks itself.
 */
export const ROLE_FACTS_SQL = `
  select
    current_user as role,
    (select r.rolsuper from pg_roles r where r.rolname = current_user) as super,
    (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypass
`;

export function readRoleFacts(rows: unknown[]): RoleFacts {
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  const truthy = (value: unknown) => value === true || value === "t";
  return {
    role: String(row.role ?? "unknown"),
    super: truthy(row.super),
    bypassesRls: truthy(row.bypass),
  };
}
