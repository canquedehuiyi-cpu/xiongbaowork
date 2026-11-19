import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  type CapturedCapability,
  captureCapability,
  currentTenant,
  runAsTenant,
  TenantContextError,
  tenantFrame,
} from "../tenant/context";
import * as schema from "./schema";
import { TEAM_TENANT } from "./schema/tenant";

/**
 * Bun's transaction session: callable as a template tag, and every statement run through it goes on
 * the single connection the transaction opened.
 */
type Transaction = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<unknown>;

/**
 * One percent-decoded part of the address, or a refusal that names it.
 *
 * A password is where this bites. `postgres://openbot:100%pure@host:5432/openbot` is a string
 * `new URL` accepts without complaint, and `decodeURIComponent` then rejects with `URIError: URI
 * error` -- a message that names neither `DATABASE_URL` nor which part of it was wrong, thrown out
 * of the one function whose whole job is to make a connection failure legible. A `%` that starts no
 * escape is a common thing to find in a generated password, and every other malformed address here
 * is answered with a sentence saying what to fix.
 */
function decodePart(value: string, part: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError(
      `DATABASE_URL has a ${part} that is not percent-encoded. A literal "%" must be written "%25".`,
    );
  }
}

/** Whether `version` is at least `major.minor`. Pre-release suffixes are ignored. */
function atLeast(version: string, major: number, minor: number): boolean {
  const [have = 0, haveMinor = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return have > major || (have === major && haveMinor >= minor);
}

/**
 * `sslmode` and `sslrootcert`, turned into the `tls` option Bun reads instead.
 *
 * They are libpq's client settings, not Postgres parameters. Forwarded as connection parameters
 * they were refused (`unrecognized configuration parameter "sslmode"`), and the connection was
 * opened without TLS first, which a database that requires TLS answers with `no pg_hba.conf entry
 * ... no encryption`. RDS, Cloud SQL and Azure Database all require it by default, and
 * `?sslmode=require` is what the deployment docs tell them to carry.
 *
 * Only the modes Bun can honour are accepted, each checked against a real server:
 *
 * - `require` encrypts and checks nothing, which is libpq's meaning too.
 * - `verify-full` checks the chain and the host name, against `sslrootcert` when given. Bun 1.3.x
 *   connects regardless, to a self-signed server and to a certificate naming another host, so on
 *   that Bun it is refused rather than allowed to look like verification.
 * - `verify-ca` would check the chain and not the name, and Bun ignores the hook that skips the
 *   name, so it is refused rather than quietly made stricter.
 * - `prefer` and `allow` try one way and fall back to the other, which Bun cannot do, so they are
 *   refused rather than quietly made one or the other.
 */
function tlsOf(params: URLSearchParams, bunVersion: string) {
  const mode = params.get("sslmode");
  const rootCert = params.get("sslrootcert");
  if (rootCert !== null && mode !== "verify-full") {
    throw new TypeError(
      "DATABASE_URL has sslrootcert, which is only read with sslmode=verify-full.",
    );
  }
  switch (mode) {
    case null:
      return {};
    case "disable":
      return { tls: false as const };
    case "require":
      return { tls: { rejectUnauthorized: false } };
    case "verify-full": {
      if (!atLeast(bunVersion, 1, 4)) {
        throw new TypeError(
          `DATABASE_URL has sslmode=verify-full, which needs Bun 1.4 or later to check the certificate. This is Bun ${bunVersion}. Use sslmode=require to encrypt without checking it.`,
        );
      }
      if (rootCert === null) return { tls: { rejectUnauthorized: true } };
      let ca: string;
      try {
        ca = readFileSync(rootCert, "utf8");
      } catch {
        throw new TypeError(
          `DATABASE_URL: sslrootcert ${rootCert} could not be read.`,
        );
      }
      return { tls: { rejectUnauthorized: true, ca } };
    }
    case "verify-ca":
      throw new TypeError(
        "DATABASE_URL has sslmode=verify-ca, which is not supported: Bun cannot check the certificate authority without the host name. Use sslmode=verify-full.",
      );
    case "prefer":
    case "allow":
      throw new TypeError(
        `DATABASE_URL has sslmode=${mode}, which is not supported: Bun cannot fall back between TLS and plain connections. Use sslmode=require, or sslmode=disable.`,
      );
    default:
      throw new TypeError(
        `DATABASE_URL has sslmode=${mode}, which is not one of disable, require or verify-full.`,
      );
  }
}

/**
 * The address, taken apart, because Bun will not take it whole on every platform.
 *
 * `new SQL("postgres://user:pass@host:5432/openbot")` works on macOS and Linux and cannot work on
 * Windows: Bun reads the URL's path, `/openbot`, as the path of a unix socket, ignores the host and
 * the port, and fails to open a socket that Windows does not have (oven-sh/bun#27713). The server
 * then cannot reach Postgres at all there, while `psql` inside the container and a plain TCP
 * connection from the same machine both succeed, which is what makes it look like a network fault
 * and not a parsing one.
 *
 * Passing the parts leaves nothing to parse. The behaviour is identical where the URL already
 * worked, since these are the same values Bun would have derived.
 *
 * Exported for its tests. `bunVersion` is a parameter so they can check both sides of the Bun 1.4
 * line from whichever Bun runs them.
 */
export function addressOf(
  databaseUrl: string,
  bunVersion: string = Bun.version,
) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // The value is not echoed back. DATABASE_URL holds the database password, and the one string
    // most likely to fail `new URL` is one with a stray character in that password, so printing it
    // to name the fault would put the credential in the log line that reports it. Name the variable
    // and the shape it expects, the way every other refusal in this function does.
    throw new TypeError(
      "DATABASE_URL is not a valid URL. Expected postgres://user:password@host:port/database.",
    );
  }
  if (url.hostname === "") {
    throw new TypeError(
      "DATABASE_URL names no host. Expected postgres://user:password@host:port/database.",
    );
  }
  const database = decodePart(url.pathname.replace(/^\//, ""), "database name");
  if (database === "") {
    throw new TypeError(
      "DATABASE_URL names no database. Expected postgres://user:password@host:port/database.",
    );
  }
  /*
   * The query string is carried across as connection parameters, not dropped.
   *
   * `?application_name=…` is the one that matters here: the profile store's serialization tests
   * name a session that way and then look for it in `pg_stat_activity`, so losing it turns a lock
   * test into a three second timeout with nothing to say why. Anything else Postgres accepts on a
   * URL travels the same way. `sslmode` and `sslrootcert` do not: Postgres refuses them, and they
   * become the `tls` option below.
   */
  const tls = tlsOf(url.searchParams, bunVersion);
  const connection = Object.fromEntries(
    [...url.searchParams].filter(
      ([name]) => name !== "sslmode" && name !== "sslrootcert",
    ),
  );

  /*
   * A port that is not a port is refused before a socket is ever opened.
   *
   * `new URL` already rejects `:65536` and above, but `:0` parses to `"0"` and would travel
   * into `new SQL({ port: 0 })` as `0`. Boot then succeeds and every query fails against a port
   * nothing listens on, instead of the start-up refusal every other malformed address here gets.
   * Postgres ports are 1-65535, the same range the server's own `PORT`/`SERVER_PORT` enforces.
   */
  let port = 5432;
  if (url.port !== "") {
    port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(
        "DATABASE_URL names a port that is not between 1 and 65535.",
      );
    }
  }

  return {
    adapter: "postgres" as const,
    hostname: url.hostname,
    port,
    username: decodePart(url.username, "username"),
    password: decodePart(url.password, "password"),
    database,
    ...(Object.keys(connection).length > 0 ? { connection } : {}),
    ...tls,
  };
}

/**
 * `max` is exposed so tests can pin the pool to a single connection. Code that opens a transaction
 * and then reads on a second connection deadlocks once every pooled connection is inside such a
 * transaction; a pool of one turns that from a load-dependent production hang into an immediate,
 * reproducible failure.
 */
export function createDatabase(
  databaseUrl: string,
  options: { max?: number } = {},
) {
  /*
   * Loud rather than silent when the arguments are the wrong way round.
   *
   * Bun's `SQL` takes either a URL or an options object as its one argument, so a caller passing the
   * pool options where the address belongs gets a working database from `$DATABASE_URL` and no
   * complaint. Two tests were doing exactly that, green for a reason that had nothing to do with
   * what they were checking, and the test tree is not type-checked so nothing else was going to say
   * so. A connection string is a string.
   */
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new TypeError(
      "createDatabase needs a connection string as its first argument. Pool options go second.",
    );
  }
  /*
   * `$DATABASE_URL` is taken out of the environment first, and stays out.
   *
   * Passing the parts is not enough on its own: Bun reads `$DATABASE_URL` when one is set and
   * prefers it to what the caller passed, so the address goes back through the parser this exists
   * to avoid and Windows fails exactly as before. Observed, not assumed: the options form connects
   * from a Bun script with no `$DATABASE_URL` set and fails inside the server, which is started
   * with `--env-file`, until the variable is gone.
   *
   * Nothing else reads it after this point. `loadConfig` has already captured it, and the worker
   * reads it into a local before it opens a database. Removing it also means a later
   * `new SQL()` cannot silently connect somewhere nobody named.
   */
  const configuredUrl = databaseUrl;
  delete process.env.DATABASE_URL;

  const raw = new SQL({
    ...addressOf(configuredUrl),
    ...(options.max === undefined ? {} : { max: options.max }),
  });

  /*
   * `team` is a stamp, never a frame (G01-E): no statement runs with `app.tenant_id = 'team'`, in
   * which every shared row would pass as the caller's own. `runAsTenant` already refuses to open
   * such a frame; this is the same refusal at the last place a tenant reaches the session.
   */
  const refuseTeam = (tenant: string): string => {
    if (tenant === TEAM_TENANT)
      throw new TenantContextError("'team' is a stamp, never a frame");
    return tenant;
  };

  /*
   * Every query carries a tenant onto its session.
   *
   * Bun 1.3.14 has no `SQL#set` on this platform, so the mechanism is a reserved connection:
   * `set_config` and the statement run on the same session, and releasing resets it -- verified
   * against the server, which is what makes forgetting a tenant fail closed rather than leak.
   *
   * The intercepted names are the ones drizzle's bun-sql session actually calls: `unsafe` for
   * statements, `begin` and `savepoint` for transactions. A transaction carries its tenant on the
   * session it opened — see the interception below — rather than borrowing a second connection.
   *
   * `tenantOf` answers which tenant that is. For a client pinned to a tenant (see `clientFor`) it is
   * that tenant, whatever frame happens to be current when the statement runs; for the unpinned
   * client it is the frame current at that moment. It is asked synchronously, before the first await.
   *
   * `capabilityOf` answers the admin capability the same way: the one captured with the pin for a
   * pinned client, so a statement Bun runs outside the caller's context keeps it exactly as it keeps
   * the tenant; the one held right now for the unpinned client.
   */
  type CapabilityOf = (tenant: string) => CapturedCapability;
  const withTenant = async <T>(
    tenantOf: () => string,
    capabilityOf: CapabilityOf,
    run: (scoped: SQL) => Promise<T>,
  ): Promise<T> => {
    const tenant = refuseTeam(tenantOf());
    // Read with the tenant, synchronously: the capability is granted for one tenant (see
    // `capabilityFor`), and it is ALWAYS written, as `''` when absent, so no pooled connection
    // carries an earlier request's capability into this statement.
    const { capability } = capabilityOf(tenant);
    const conn = await raw.reserve();
    try {
      await conn`select set_config('app.tenant_id', ${tenant}, false), set_config('app.capability', ${capability}, false)`;
      return await run(conn as unknown as SQL);
    } finally {
      conn.release();
    }
  };

  /*
   * `unsafe` answers with Bun's Query object, and drizzle uses both halves of it: it awaits the
   * rows, and it calls `.values()` for positional results. A plain Promise loses the second half,
   * so the await path and the values path are wrapped together.
   */
  type UnsafeCall = (query: string, params?: unknown[]) => unknown;
  const tenantUnsafe = (
    tenantOf: () => string,
    capabilityOf: CapabilityOf,
  ): UnsafeCall => {
    const run = (query: string, params?: unknown[]) =>
      withTenant(tenantOf, capabilityOf, async (scoped) => {
        const result = await (
          scoped.unsafe as (
            q: string,
            p?: unknown[],
          ) => Promise<unknown[]> & {
            values: () => Promise<unknown[]>;
          }
        )(query, params);
        // Bun answers with a RowList; callers and tests compare plain arrays.
        return Array.from(result as ArrayLike<unknown>);
      });
    return (query: string, params?: unknown[]) => {
      /*
       * Lazy and memoised on EACH arm: drizzle builds `unsafe(q, p)` and then
       * chooses `await` or `.values()`. Starting the object arm at build time
       * as well would run an INSERT twice -- once for the discarded promise,
       * once for the values call -- so neither arm moves until it is asked
       * for, and asking twice returns the same run.
       */
      let objectRun: Promise<unknown[]> | null = null;
      let valuesRun: Promise<unknown[][]> | null = null;
      return {
        // biome-ignore lint/suspicious/noThenProperty: this arm IS awaited; `then` is the hook that carries the tenant frame
        then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          // biome-ignore lint/suspicious/noAssignInExpressions: one run shared by both arms, so `??=` is the memo
          (objectRun ??= run(query, params)).then(onF, onR),
        catch: (onR?: (e: unknown) => unknown) =>
          // biome-ignore lint/suspicious/noAssignInExpressions: one run shared by both arms, so `??=` is the memo
          (objectRun ??= run(query, params)).catch(onR),
        finally: (onF?: () => void) =>
          // biome-ignore lint/suspicious/noAssignInExpressions: one run shared by both arms, so `??=` is the memo
          (objectRun ??= run(query, params)).finally(onF),
        values: () =>
          (valuesRun ??= withTenant(tenantOf, capabilityOf, async (scoped) => {
            const rows = await (
              scoped.unsafe as (
                q: string,
                p?: unknown[],
              ) => PromiseLike<unknown[][]> & {
                values: () => PromiseLike<unknown[][]>;
              }
            )(query, params).values();
            return Array.from(rows as ArrayLike<unknown[]>, (row) =>
              Array.from(row),
            );
          })),
      };
    };
  };

  /*
   * The pool as drizzle sees it, pinned to `pinned` when there is one.
   *
   * Pinning is the root of the fix for a frame lost between building a statement and running it.
   * drizzle builders are lazy: `.from()`, `.where()`, `.returning()` each make a NEW object whose
   * `then` nobody wrapped, and the statement only reaches `unsafe` when that `then` is called. Bun
   * 1.3.14 calls it OUTSIDE the caller's AsyncLocalStorage frame when an async function has already
   * awaited something and then returns the builder unawaited
   * (`runAsTenant(t, async () => { await x; return db.select().from(t) })`), so a client that read
   * the frame at that moment ran the statement as `system` (the old answer outside a frame; since
   * G01-E it throws instead): row-level security answered with nothing, and a write leaning on the
   * `tenant_id` default would have landed in the partition every tenant reads. Every builder,
   * prepared statement, relational query and transaction drizzle makes reaches the database through
   * the session of the instance it was made on, so pinning the instance's client to the tenant it
   * was made for carries that tenant into execution with nothing wrapped -- no builder, table or SQL
   * chunk changes identity, and `instanceof`, `.as()`, subquery embedding, `.toSQL()` and
   * `.prepare()` behave exactly as drizzle wrote them.
   *
   * The admin capability is pinned alongside the tenant (G01-E), for the same reason: it lives in
   * AsyncLocalStorage too, so read at execution time it was gone exactly when the tenant would have
   * been, and an administrator's `await x; return database.update(...)` ran without
   * `app.capability`. `pinnedCapability` is what was held for `pinned` when the instance was chosen.
   */
  const clientFor = (
    pinned: string | undefined,
    pinnedCapability?: CapturedCapability,
  ) => {
    if (pinned !== undefined) refuseTeam(pinned);
    const tenantOf = pinned === undefined ? currentTenant : () => pinned;
    const capabilityOf: CapabilityOf =
      pinned === undefined || pinnedCapability === undefined
        ? captureCapability
        : () => pinnedCapability;
    return new Proxy(raw, {
      get(target, property, receiver) {
        if (property === "unsafe") {
          return tenantUnsafe(tenantOf, capabilityOf);
        }
        if (property === "begin" || property === "savepoint") {
          const method = (
            target as unknown as Record<
              string,
              (fn: (tx: Transaction) => unknown) => Promise<unknown>
            >
          )[property as string];
          return (fn: (tx: Transaction) => unknown) => {
            /*
             * The tenant is read HERE, before the transaction opens, not inside its callback: Bun runs
             * that callback from its own connection machinery, a turn after the caller's scope, and by
             * then the frame is gone. Measured rather than assumed — read late, every write inside a
             * transaction landed in the `system` partition, which row-level security shows to everybody.
             *
             * It is set on the transaction's own session rather than by reserving a connection here and
             * running `begin` on that: `begin` takes a connection of its own, so a transaction held two
             * — one idle while the other worked — and a pool of two deadlocked on the second concurrent
             * write. Awaiting the rejection that shape produced ALSO reported it as an unhandled
             * rejection, so every error thrown inside a transaction — a protected coworker, a model from
             * somebody else's library — reached the person as a refusal and as a server fault at once.
             *
             * `is_local = true` lasts exactly the transaction, so the pooled connection carries no
             * tenant — and no capability, which is written alongside it the same way `withTenant`
             * writes it — into whatever the next caller runs on it.
             *
             * The callback itself runs inside `runAsTenant(tenant)` (G01-E). Bun calls it from its own
             * connection machinery, outside the caller's frame, so without this a `currentTenant()`
             * read anywhere inside the transaction — a store stamping a row, `sealedRow` binding an
             * envelope — fell back to `system` while the session's `app.tenant_id` said otherwise
             * (and since G01-E would throw, there being no answer outside a frame).
             * The capability is re-entered with it, from the same capture that wrote
             * `app.capability`, so `capabilityFor(currentTenant())` inside the callback (a credential
             * sealed to `team`, say) answers what the session says rather than `''`.
             */
            const tenant = refuseTeam(tenantOf());
            const held = capabilityOf(tenant);
            return method.call(target, async (tx) => {
              await tx`select set_config('app.tenant_id', ${tenant}, true), set_config('app.capability', ${held.capability}, true)`;
              return held.run(() => runAsTenant(tenant, () => fn(tx)));
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };

  /*
   * One drizzle instance per tenant frame, over one pool.
   *
   * drizzle caches prepared statements and their results by query text on the instance. Under RLS
   * the same statement answers differently per tenant, so a shared instance would let tenant B
   * receive tenant A's cached rows -- a leak no policy can stop. Separate instances keep the
   * caches apart while the connection pool stays common.
   *
   * Each instance's client is pinned to its tenant (see `clientFor`). The one instance made outside
   * every frame is not pinned: its client asks `currentTenant()` when a statement executes, so it runs
   * as whichever frame executes it, and throws when none does (G01-E: there is no `system` answer
   * outside a frame any more). It is the proxy's target and stays the unpinned fallback of
   * `instanceFor`, but the getter below never reaches it: `currentTenant()` there throws before any
   * instance is chosen, so not even a builder made at module scope can be made outside a frame.
   */
  const unframed = drizzle({ client: clientFor(undefined), schema });
  /*
   * Keyed by frame AND capability: an administrator's request and the same administrator's routine
   * share a frame but not a capability, and each instance's client carries the one it was made for.
   * Keeping their statement caches apart is right for the same reason as keeping tenants apart —
   * the capability changes what row-level security answers.
   */
  const byTenant = new Map<string, typeof unframed>();
  const instanceFor = (frame: string | undefined) => {
    if (frame === undefined) return unframed;
    const held = captureCapability(frame);
    const key = `${held.capability}\u0000${frame}`;
    let instance = byTenant.get(key);
    if (!instance) {
      instance = drizzle({ client: clientFor(frame, held), schema });
      byTenant.set(key, instance);
    }
    return instance;
  };

  return new Proxy(unframed, {
    get(_target, property) {
      /*
       * The pool itself, unwrapped.
       *
       * Bun's `SQL` reaches its own state through private fields, and a private lookup against a
       * Proxy receiver is a TypeError rather than the field — so a caller that wants the client
       * (`close`, which every integration file calls when it tears its pool down) has to be handed
       * the client, not a wrapper of it. Every tenant gate lives in the statements this pool runs,
       * not in the object, so handing it out opens no door that `unsafe` did not already.
       */
      if (property === "$client") return raw;
      /*
       * Asked first, so ANY use of the client outside every frame — building a statement, opening a
       * transaction, reading `query` — is a `TenantContextError` here, before drizzle sees it.
       */
      const tenant = currentTenant();
      const frame = tenantFrame();
      const instance = instanceFor(frame) as unknown as Record<
        string | symbol,
        unknown
      >;
      const value = instance[property];
      if (typeof value !== "function") return value;
      const bound = value.bind(instance);
      /*
       * The call itself also runs inside the captured frame, and a thenable it returns directly
       * (`db.execute(...)`, `db.delete(...)`) has its `then` re-entered there too. The pinned client
       * above is what actually decides the tenant a statement runs as; this keeps anything drizzle
       * reads from the frame while BUILDING a statement on the same tenant.
       */
      return (...args: unknown[]) => runAsTenant(tenant, () => bound(...args));
    },
  });
}

export type Database = ReturnType<typeof createDatabase>;
