import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { currentTenant, runAsTenant } from "../tenant/context";
import * as schema from "./schema";

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
 */
function addressOf(databaseUrl: string) {
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
   * URL, `sslmode` and the rest, travels the same way.
   */
  const connection = Object.fromEntries(url.searchParams);

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
   * Every query carries the tenant from AsyncLocalStorage.
   *
   * Bun 1.3.14 has no `SQL#set` on this platform, so the mechanism is a reserved connection:
   * `set_config` and the statement run on the same session, and releasing resets it -- verified
   * against the server, which is what makes forgetting a tenant fail closed rather than leak.
   *
   * The intercepted names are the ones drizzle's bun-sql session actually calls: `unsafe` for
   * statements, `begin` and `savepoint` for transactions. A transaction carries its tenant on the
   * session it opened — see the interception below — rather than borrowing a second connection.
   */
  const withTenant = async <T>(
    run: (scoped: SQL) => Promise<T>,
  ): Promise<T> => {
    const conn = await raw.reserve();
    try {
      await conn`select set_config('app.tenant_id', ${currentTenant()}, false)`;
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
  const tenantUnsafe = (): UnsafeCall => {
    const run = (query: string, params?: unknown[]) =>
      withTenant(async (scoped) => {
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
          (valuesRun ??= withTenant(async (scoped) => {
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

  const client = new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return tenantUnsafe();
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
           * tenant into whatever the next caller runs on it.
           */
          const tenant = currentTenant();
          return method.call(target, async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenant}, true)`;
            return fn(tx);
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const base = drizzle({ client, schema });

  /*
   * One drizzle instance per tenant, over one pool.
   *
   * drizzle caches prepared statements and their results by query text on the instance. Under RLS
   * the same statement answers differently per tenant, so a shared instance would let tenant B
   * receive tenant A's cached rows -- a leak no policy can stop. Separate instances keep the
   * caches apart while the connection pool stays common.
   */
  const byTenant = new Map<string, typeof base>();
  const instanceFor = () => {
    const tenant = currentTenant();
    let instance = byTenant.get(tenant);
    if (!instance) {
      instance = drizzle({ client, schema });
      byTenant.set(tenant, instance);
    }
    return instance;
  };

  return new Proxy(base, {
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
      const tenant = currentTenant();
      const instance = instanceFor() as unknown as Record<
        string | symbol,
        unknown
      >;
      const value = instance[property];
      if (typeof value !== "function") return value;
      const bound = value.bind(instance);
      /*
       * drizzle builders execute lazily -- `runAsTenant(t, () => db.select(...))` returns a
       * builder whose query runs after the scope has ended. Capturing the tenant here and
       * re-entering it at call time is what keeps that pattern on the right tenant instead of
       * silently falling back to `system` and reading nothing.
       */
      return (...args: unknown[]) => runAsTenant(tenant, () => bound(...args));
    },
  });
}

export type Database = ReturnType<typeof createDatabase>;
