import { randomBytes } from "node:crypto";
import { SQL } from "bun";

/**
 * The database integration suite must never fall back to the developer's application database.
 * `createDatabase` deliberately removes `process.env.DATABASE_URL` after opening a connection so Bun
 * cannot ignore the explicit connection parts on Windows. That means a later test that reads
 * `process.env.DATABASE_URL ?? localhost/openbot` can silently fall into the live development DB.
 * Resolve one explicit test URL before opening a test pool and make the unsafe shape impossible.
 */
let cachedTestDatabaseUrl: string | undefined;

export function testDatabaseUrl() {
  cachedTestDatabaseUrl ??= testDatabaseUrlFrom(process.env);
  return cachedTestDatabaseUrl;
}

export function testDatabaseUrlFrom(
  environment: Record<string, string | undefined>,
) {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL must point at a dedicated PostgreSQL test database. Do not rely on DATABASE_URL; createDatabase removes it to preserve the Windows Bun connection fix.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must be a PostgreSQL URL such as postgres://openbot:openbot@localhost:5432/openbot_test.",
    );
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    throw new Error(
      "TEST_DATABASE_URL must use the postgres:// or postgresql:// protocol.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("TEST_DATABASE_URL must name a database.");
  }
  if (database === "openbot") {
    throw new Error(
      "TEST_DATABASE_URL must not point at the live openbot database. Use a dedicated database such as openbot_test.",
    );
  }
  return raw;
}

/**
 * How many connections one test file may hold.
 *
 * The suite runs in a single process, so every file that opens a pool holds it for the whole run and
 * the totals add up rather than take turns. Left at the driver's default the suite sat at 83 of
 * PostgreSQL's 100, which is not a limit anybody set and not one that shows up until a file is added
 * and something unrelated fails on a machine slower than the author's.
 *
 * Two, because a test that opens a transaction and reads inside it needs a second connection to do
 * so. A test that wants the deadlock that pinning to one exposes asks for `{ max: 1 }` itself.
 */
export const TEST_POOL = { max: 2 } as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DISPOSABLE_NAME = /^openbot_continuation_test_[0-9a-f]{16}$/;
const TEMPLATE_NAME = /^openbot_continuation_template$/;

export interface DisposableTestDatabase {
  /** Same credentials as the chosen role, pointed at the new one-time database. */
  readonly url: string;
  readonly databaseName: string;
  /** Drops the one-time database. Call after every pool on `url` is closed. */
  drop(): Promise<void>;
}

function loopbackPostgresUrl(raw: string | undefined, name: string): URL {
  if (!raw?.trim()) {
    throw new Error(`BLOCKED_NOT_DISPOSABLE: ${name} is not configured`);
  }
  const url = new URL(raw.trim());
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`BLOCKED_NOT_DISPOSABLE: ${name} must be a loopback postgres:// URL`);
  }
  return url;
}

/**
 * A one-time, empty, fully migrated database for suites that must own every row they see (the D06
 * continuation suites check `users` is empty and that the database name is
 * `openbot_continuation_test_<16hex>`).
 *
 * It is cloned from `TEST_DATABASE_TEMPLATE` (migrated by the owner and never connected to) through
 * `TEST_DATABASE_ADMIN_URL`, so the test itself applies no migration and no grant. The suite connects
 * as `openbot_app` (from `TEST_DATABASE_URL`, via `testDatabaseUrl`) or, for `role: "bypass"`, with
 * the credentials of `TEST_DATABASE_BYPASS_URL`: a NOSUPERUSER BYPASSRLS fixture role needed to read
 * and write the closed (FORCE RLS, zero-policy) approval continuation ledger. Every URL must be
 * loopback; the name is generated here, which is the disposable acknowledgment.
 */
export async function createDisposableTestDatabase(
  options: { role?: "app" | "bypass" } = {},
  environment: Record<string, string | undefined> = process.env,
): Promise<DisposableTestDatabase> {
  const app = loopbackPostgresUrl(
    environment === process.env ? testDatabaseUrl() : testDatabaseUrlFrom(environment),
    "TEST_DATABASE_URL",
  );
  const admin = loopbackPostgresUrl(environment.TEST_DATABASE_ADMIN_URL, "TEST_DATABASE_ADMIN_URL");
  const credentials =
    options.role === "bypass"
      ? loopbackPostgresUrl(environment.TEST_DATABASE_BYPASS_URL, "TEST_DATABASE_BYPASS_URL")
      : app;
  const template = environment.TEST_DATABASE_TEMPLATE?.trim() ?? "";
  if (!TEMPLATE_NAME.test(template)) {
    throw new Error("BLOCKED_NOT_DISPOSABLE: TEST_DATABASE_TEMPLATE must be openbot_continuation_template");
  }
  const databaseName = `openbot_continuation_test_${randomBytes(8).toString("hex")}`;
  if (!DISPOSABLE_NAME.test(databaseName)) throw new Error("BLOCKED_NOT_DISPOSABLE");

  // Bun prefers $DATABASE_URL over explicit parts (see createDatabase); never let it pick the target.
  delete process.env.DATABASE_URL;
  const client = new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(admin.pathname.replace(/^\//, "")) || "postgres",
    max: 1,
  });
  try {
    // The suite's own role is never a superuser, and only the explicit fixture role may bypass RLS:
    // the app role must stay bound by the policies these suites exercise.
    const roleName = decodeURIComponent(credentials.username);
    const [facts] = await client`
      select rolsuper as super, rolbypassrls as bypass
      from pg_catalog.pg_roles where rolname = ${roleName}
    `;
    if (
      facts?.super !== false ||
      facts.bypass !== (options.role === "bypass")
    ) {
      throw new Error(
        "BLOCKED_NOT_DISPOSABLE: the suite role must be NOSUPERUSER, and BYPASSRLS only for role \"bypass\"",
      );
    }
    // Both names are fixed-shape identifiers checked above; CREATE DATABASE takes no parameters.
    await client.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "${template}"`);
  } catch (error) {
    await client.close();
    throw error;
  }

  const url = new URL(credentials.toString());
  url.pathname = `/${databaseName}`;
  let dropped = false;
  return {
    url: url.toString(),
    databaseName,
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await client.close();
      }
    },
  };
}
