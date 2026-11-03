import { judgeRlsEnforcement } from "../db/rls-role";
import { runAsTenant } from "../tenant/context";

export type ReadinessDiagnostic =
  | { type: "rls-role-check-unavailable"; reason: string }
  | { type: "rls-not-enforced"; role: string; reason: string; fix: string }
  | { type: "database-password-public-default"; role: string; fix: string };

export type RlsEnforcementMode = "refuse" | "warn";

/**
 * Whether an unenforced or unconfirmed RLS role stops the server (audit defect #8).
 *
 * Refuse unless somebody wrote `OPENBOT_RLS_ENFORCE=warn`, or `NODE_ENV` says development or test.
 * Not "warn unless production": `NODE_ENV` is unset on a hand-written server env file, which is
 * exactly the deployment that connects with the owner string by mistake (see dev-actor.ts for the
 * same lesson). Anything other than the two words refuses to start rather than being read as warn,
 * so a typo cannot switch the first isolation layer off.
 */
export function resolveRlsEnforcementMode(
  environment: Record<string, string | undefined>,
): RlsEnforcementMode {
  const written = environment.OPENBOT_RLS_ENFORCE?.trim().toLowerCase();
  if (written === "refuse" || written === "warn") return written;
  if (written)
    throw new Error(
      `OPENBOT_RLS_ENFORCE must be "refuse" or "warn" (got "${written}"). Leave it unset to refuse.`,
    );
  const nodeEnvironment = environment.NODE_ENV?.trim();
  return nodeEnvironment === "development" || nodeEnvironment === "test"
    ? "warn"
    : "refuse";
}

/** The password `0054_app_role.sql` gives `openbot_app`, and the compose owner's; both are public. */
const PUBLIC_DEFAULT_DATABASE_PASSWORD = "openbot";

/** The role name when `url` authenticates with the public default password, else undefined. */
function publicDefaultCredentialRole(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (decodeURIComponent(parsed.password) !== PUBLIC_DEFAULT_DATABASE_PASSWORD)
      return undefined;
    return decodeURIComponent(parsed.username) || "unknown";
  } catch {
    return undefined;
  }
}

export function usesPublicDefaultDatabasePassword(
  url: string | undefined,
): boolean {
  return publicDefaultCredentialRole(url) !== undefined;
}

/**
 * Refuse, in production, a DATABASE_URL whose password is the one printed in this repository.
 *
 * A migration cannot do this: PostgreSQL does not hand a password back, so it cannot tell a role an
 * operator secured from one still on 0054's default, and resetting it would lock the second kind out
 * silently. The connection string is the one credential the server holds, and with password
 * authentication a role has exactly one password, so a URL that authenticates with `openbot` means
 * the role still accepts it from anywhere that can reach the database. Never echoes the URL.
 */
export function checkDatabaseCredential(options: {
  url: string | undefined;
  production: boolean;
  report: (event: ReadinessDiagnostic) => void;
}): void {
  const role = publicDefaultCredentialRole(options.url);
  if (role === undefined) return;
  options.report({
    type: "database-password-public-default",
    role,
    fix: `set a new password (ALTER ROLE ${role} PASSWORD '<random>') and put it in DATABASE_URL; the default from 0054_app_role.sql is public.`,
  });
  if (options.production)
    throw new Error(
      "DATABASE_URL uses the public default database password; refusing to start in production.",
    );
}

/** Read real role facts before consumers start; unknown is not a false privilege flag. */
export async function checkServerReadiness(options: {
  read: () => Promise<unknown>;
  mode: string | undefined;
  report: (event: ReadinessDiagnostic) => void;
}): Promise<void> {
  // Only an explicit "warn" relaxes the gate; a missing mode refuses.
  const strict = options.mode !== "warn";
  let rows: unknown;
  try {
    /*
     * As `platform` (G01): the role facts are the deployment's, and boot has no frame. Unframed, the
     * read took the legacy `system` fallback today and a `TenantContextError` once the fallback is
     * gone, which this catch would turn into "role facts unavailable" and, under `refuse`, a server
     * that will not start for a reason that has nothing to do with its role.
     */
    rows = await runAsTenant("platform", () => options.read());
  } catch {
    rows = undefined;
  }
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const boolean = (value: unknown): boolean | undefined => {
    if (value === true || value === "t") return true;
    if (value === false || value === "f") return false;
    return undefined;
  };
  if (
    row !== null &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    "role" in row &&
    typeof row.role === "string" &&
    row.role.trim() &&
    "super" in row &&
    "bypass" in row
  ) {
    const superuser = boolean(row.super);
    const bypassesRls = boolean(row.bypass);
    if (superuser !== undefined && bypassesRls !== undefined) {
      const verdict = judgeRlsEnforcement({
        role: row.role,
        super: superuser,
        bypassesRls,
      });
      if (verdict.enforced) return;
      options.report({
        type: "rls-not-enforced",
        role: row.role,
        reason: verdict.reason,
        fix: verdict.fix,
      });
      if (strict)
        throw new Error("Tenant isolation preflight refused startup.");
      return;
    }
  }
  options.report({
    type: "rls-role-check-unavailable",
    reason: "Tenant isolation role facts are unknown or unavailable.",
  });
  if (strict) throw new Error("Tenant isolation preflight is unconfirmed.");
}

/** Own the restricted pool without exposing its URL or driver errors to process logs. */
export function createRoleWriterLifecycle<Connection>(options: {
  application: Connection;
  url: string | undefined;
  create: (url: string) => Connection | Promise<Connection>;
  initialize: (application: Connection, writer: Connection) => Promise<void>;
  /** Must synchronously seal admission, then settle only after all admitted writes settle. */
  stop: (application: Connection) => Promise<void>;
  close: (writer: Connection) => Promise<void>;
}): { start(): Promise<void>; stop(): Promise<void> } {
  // Consume once: the URL never becomes part of the returned lifecycle or its errors.
  let url = options.url;
  options.url = undefined;
  let writer: Connection | undefined;
  let bound = false;
  let stopping = false;
  let initialization: Promise<void> | undefined;
  let readiness: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let release: Promise<void> | undefined;

  function releaseWriter(): Promise<void> {
    if (release) return release;
    release = (async () => {
      const failures: Error[] = [];
      if (bound) {
        try {
          // Called before the first await: seal cannot race a later admission.
          await options.stop(options.application);
        } catch {
          failures.push(
            new Error("Role writer drain failed or is unconfirmed."),
          );
        }
      }
      if (writer !== undefined) {
        try {
          await options.close(writer);
        } catch {
          failures.push(
            new Error("Role writer pool close failed or is unconfirmed."),
          );
        }
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Role writer cleanup is unconfirmed.",
        );
      }
    })();
    return release;
  }

  return {
    start() {
      if (stopping)
        return Promise.reject(new Error("Role writer startup is sealed."));
      if (readiness) return readiness;
      const dedicatedUrl = url;
      url = undefined;
      initialization = (async () => {
        try {
          if (!dedicatedUrl?.trim()) {
            throw new Error("Missing dedicated role writer URL.");
          }
          // Role and catalogue facts belong to no tenant: the boot path asks as `platform`, never
          // through the legacy unframed fallback (G01-E P3). Creating the pool is framed too:
          // resolving a promise with a `Database` reads its `then`, which the tenant proxy answers
          // from the current frame, so an unframed `await` of the new pool is itself a frame read.
          const created = await runAsTenant("platform", () =>
            Promise.resolve(options.create(dedicatedUrl)),
          );
          writer = created;
          await runAsTenant("platform", () =>
            options.initialize(options.application, created),
          );
          bound = true;
        } catch {
          const failure = new Error("Role writer initialization failed.");
          try {
            await releaseWriter();
          } catch {
            throw new AggregateError(
              [
                failure,
                new Error("Role writer initialization cleanup is unconfirmed."),
              ],
              "Role writer startup failed and cleanup is unconfirmed.",
            );
          }
          throw failure;
        }
      })();
      readiness = initialization.then(async () => {
        if (stopping) {
          await releaseWriter();
          throw new Error("Role writer stopped during startup.");
        }
      });
      return readiness;
    },
    stop() {
      if (finishing) return finishing;
      stopping = true;
      url = undefined;
      // An already-bound writer is sealed in this call, not in a future promise turn.
      finishing = bound
        ? releaseWriter()
        : initialization
          ? initialization.then(() => releaseWriter())
          : Promise.resolve();
      return finishing;
    },
  };
}

export type StartupScope = {
  step<Value>(work: () => Promise<Value>): Promise<Value>;
  acquire<Value>(
    work: () => Promise<Value>,
    close: (value: Value) => void | Promise<void>,
  ): Promise<Value>;
  acquireSync<Value>(
    work: () => Value,
    close: (value: Value) => void | Promise<void>,
  ): Value;
};

class StartupStopped extends Error {
  constructor() {
    super("Server startup is sealed.");
  }
}

/** One admission boundary for the whole bootstrap; late acquisitions are owned before refusal. */
export function createStartupLifecycle(options: { seal: () => Promise<void> }) {
  let stopping = false;
  let body: Promise<void> | undefined;
  let failed = false;
  let sealing: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  const resources: (() => void | Promise<void>)[] = [];
  const finalizers: (() => void | Promise<void>)[] = [];
  function check() {
    if (stopping) throw new StartupStopped();
  }
  function seal() {
    stopping = true;
    if (!sealing) {
      try {
        sealing = options.seal();
      } catch {
        sealing = Promise.reject(new Error("Startup seal failed."));
      }
      // A cleanup join is installed below, but a pending startup may take arbitrarily long.
      void sealing.catch(() => {});
    }
    return sealing;
  }
  function own<Value>(
    value: Value,
    close: (value: Value) => void | Promise<void>,
  ) {
    resources.push(() => close(value));
    check();
    return value;
  }
  const scope: StartupScope = {
    async step(work) {
      check();
      const value = await work();
      check();
      return value;
    },
    async acquire(work, close) {
      check();
      const value = await work();
      return own(value, close);
    },
    acquireSync(work, close) {
      check();
      return own(work(), close);
    },
  };
  function stop(): Promise<void> {
    if (finishing) return finishing;
    const sealed = seal(); // Synchronous admission seal before any await or producer cleanup.
    finishing = (async () => {
      await body; // Including any resource that arrives after stop during an awaited acquisition.
      const results = await Promise.allSettled([
        sealed,
        ...resources.map((close) => Promise.resolve().then(close)),
      ]);
      // Connections must outlive the writer drain and every registered resource cleanup.
      const finals = await Promise.allSettled(
        finalizers.map((close) => Promise.resolve().then(close)),
      );
      const failures = [...results, ...finals].filter(
        (result) => result.status === "rejected",
      );
      if (failed || failures.length) {
        throw new AggregateError(
          Array.from(
            { length: failures.length + Number(failed) },
            () => new Error("Startup or cleanup failed or is unconfirmed."),
          ),
          "Server lifecycle failed or cleanup is unconfirmed.",
        );
      }
    })();
    return finishing;
  }
  return {
    stop,
    final(close: () => void | Promise<void>) {
      check();
      finalizers.push(close);
    },
    run(work: (startup: StartupScope) => Promise<void>): Promise<void> {
      if (body || stopping) return Promise.reject(new StartupStopped());
      body = Promise.resolve()
        .then(() => {
          check();
          return work(scope);
        })
        .catch((error: unknown) => {
          if (!(stopping && error instanceof StartupStopped)) failed = true;
          seal();
        });
      return body.then(async () => {
        if (stopping) {
          await stop();
          throw new StartupStopped();
        }
      });
    },
  };
}
