import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAdminScope } from "../src/auth/admin-scope";
import {
  type AppVariables,
  type AuthenticatedActor,
  createRoleRepository,
} from "../src/auth/guards";
import type { OpenBotRole } from "../src/auth/roles";
import { setRole } from "../src/auth/roles";
import {
  CredentialRefusedError,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import {
  asPlatform,
  capabilityFor,
  currentTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * The admin capability (G01-E P2, I10): `app.capability = 'admin'` reaches the database only for a
 * request that passed `adminCapability`, by a person whose `user_roles` still says admin, and only in
 * that person's own frame. Routines and Bot turns of an admin, nested frames, and members never
 * carry it, and the two doors out of the admin's frame (`adminActAsOwner`, `asAdminPlatform`) demand
 * it.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const roleRepository = createRoleRepository(database);
const scope = createAdminScope({ roleRepository });
const suite = `admincap-${randomUUID().slice(0, 8)}`;
const admin = `${suite}-admin`;
const demoted = `${suite}-demoted`;
const member = `${suite}-member`;
const owner = `${suite}-owner`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

async function capability(): Promise<unknown> {
  const rows = (await database.execute(
    sql`select current_setting('app.capability', true) as capability`,
  )) as unknown as { capability: unknown }[];
  return rows[0]?.capability;
}

/** An app signed in as `actor` the way `createRequireUser` does it, then `adminCapability`. */
function appFor<T>(
  actor: Pick<AuthenticatedActor, "id" | "role">,
  handler: () => Promise<T>,
) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      ...actor,
      email: `${actor.id}@example.test`,
    });
    await runAsTenant(actor.id, () => next());
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", signedIn, scope.adminCapability);
  app.get("/", async (context) => context.json({ value: await handler() }));
  return async () =>
    ((await (await app.request("http://test/")).json()) as { value: T }).value;
}

/**
 * A pool of ONE connection that has never connected, closed afterwards. Bun runs a transaction's
 * callback from its connection machinery, and on a connection it has to open first that callback
 * starts outside the caller's AsyncLocalStorage: the case the transaction tests must cover.
 */
async function onFreshDatabase<T>(
  work: (fresh: typeof database) => Promise<T>,
): Promise<T> {
  const fresh = createDatabase(testDatabaseUrl(), { max: 1 });
  try {
    return await work(fresh);
  } finally {
    await fresh.$client.close();
  }
}

/** What `adminCapability` hands a handler, for code that needs the capability outside a route. */
function withAdminRequest<T>(work: () => Promise<T>) {
  return appFor({ id: admin, role: "admin" }, work)();
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(() =>
    database.insert(users).values(
      [admin, demoted, member, owner].map((id) => ({
        id,
        email: `${id}@example.test`,
      })),
    ),
  );
  const roles: [string, OpenBotRole][] = [
    [admin, "admin"],
    [demoted, "admin"],
    [member, "user"],
    [owner, "user"],
  ];
  // Role facts belong to no tenant: written as `platform`, never by the fallback.
  for (const [id, role] of roles)
    await asPlatform(() => setRole(database, id, role));
});

afterAll(async () => {
  await runAsTenant(owner, () =>
    database.delete(agents).where(like(agents.id, `${suite}-%`)),
  );
  // `user_roles` follows its user by cascade.
  await asPlatform(() =>
    database
      .delete(users)
      .where(inArray(users.id, [admin, demoted, member, owner])),
  );
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("adminCapability", () => {
  test("an administrator's request carries the capability to the database", async () => {
    expect(await appFor({ id: admin, role: "admin" }, capability)()).toBe(
      "admin",
    );
  });

  test("a member's request does not", async () => {
    expect(await appFor({ id: member, role: "user" }, capability)()).toBe("");
  });

  test("an administrator whose admin role was removed since sign-in does not", async () => {
    await asPlatform(() => setRole(database, demoted, "user"));
    // The actor still says admin — it was decided at sign-in — but `user_roles` no longer does.
    expect(await appFor({ id: demoted, role: "admin" }, capability)()).toBe("");
  });

  test("a nested frame never inherits it", async () => {
    const seen = await withAdminRequest(async () => ({
      own: await capability(),
      other: await runAsTenant(member, () => capability()),
      platform: await asPlatform(() => capability()),
      back: await capability(),
    }));
    expect(seen).toEqual({
      own: "admin",
      other: "",
      platform: "",
      back: "admin",
    });
  });

  test("a statement returned unawaited after an await still carries it", async () => {
    // Bun 1.3.14 calls the returned builder's `then` outside the caller's AsyncLocalStorage. The
    // tenant survived that because the instance is pinned to it; the capability must too.
    const seen = await withAdminRequest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return database.execute(
        sql`select current_setting('app.capability', true) as capability`,
      );
    });
    expect(seen).toEqual([{ capability: "admin" }]);
    const built = await withAdminRequest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return database
        .select({
          capability: sql<string>`current_setting('app.capability', true)`,
        })
        .from(users)
        .where(eq(users.id, admin));
    });
    expect(built).toEqual([{ capability: "admin" }]);
  });

  test("a transaction's callback holds it, matching the session", async () => {
    const seen = await withAdminRequest(() =>
      onFreshDatabase((fresh) =>
        fresh.transaction(async (transaction) => {
          const rows = (await transaction.execute(
            sql`select current_setting('app.capability', true) as capability`,
          )) as unknown as { capability: unknown }[];
          return {
            tenant: currentTenant(),
            held: capabilityFor(currentTenant()),
            session: rows[0]?.capability,
            outer: await capability(),
          };
        }),
      ),
    );
    expect(seen).toEqual({
      tenant: admin,
      held: "admin",
      session: "admin",
      outer: "admin",
    });
    // And a member's transaction holds none.
    expect(
      await appFor({ id: member, role: "user" }, () =>
        onFreshDatabase((fresh) =>
          fresh.transaction(async () => capabilityFor(currentTenant())),
        ),
      )(),
    ).toBe("");
  });

  test("an administrator's routine, which runs in their frame without the middleware, does not", async () => {
    // The `actorFor` shape in index.ts: the owner's roles are read and say admin, and the work then
    // runs as the owner — with no request, so with no capability.
    const roles = await asPlatform(() => roleRepository.rolesForUser(admin));
    expect(roles).toContain("admin");
    expect(await runAsTenant(admin, () => capability())).toBe("");
  });
});

describe("adminActAsOwner", () => {
  test("is refused without the capability", async () => {
    let ran = false;
    expect(() =>
      runAsTenant(admin, () =>
        scope.adminActAsOwner({ id: admin }, owner, () => {
          ran = true;
        }),
      ),
    ).toThrow(TenantContextError);
    expect(ran).toBe(false);
  });

  test("is refused for an actor other than the one holding the capability", async () => {
    const outcome = await withAdminRequest(async () => {
      try {
        return scope.adminActAsOwner({ id: member }, owner, () =>
          currentTenant(),
        );
      } catch (error) {
        return error instanceof TenantContextError ? "refused" : String(error);
      }
    });
    expect(outcome).toBe("refused");
  });

  test("refuses every owner that is nobody", async () => {
    const refusals = await withAdminRequest(async () =>
      ["platform", "team", "system", ""].map((nobody) => {
        try {
          scope.adminActAsOwner({ id: admin }, nobody, () => "ran");
          return "ran";
        } catch (error) {
          return error instanceof TenantContextError
            ? "refused"
            : String(error);
        }
      }),
    );
    expect(refusals).toEqual(["refused", "refused", "refused", "refused"]);
  });

  test("runs the work in the owner's frame, stamping the owner's rows, without the capability", async () => {
    const id = `${suite}-agent`;
    const seen = await withAdminRequest(() =>
      scope.adminActAsOwner({ id: admin }, owner, async () => {
        await database.insert(agents).values({
          id,
          name: "acted for the owner",
          type: "built_in",
          configuration: { systemPrompt: "test" },
        });
        return { tenant: currentTenant(), capability: await capability() };
      }),
    );
    expect(seen).toEqual({ tenant: owner, capability: "" });
    const rows = await runAsTenant(owner, () =>
      database
        .select({ tenantId: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, id)),
    );
    expect(rows).toEqual([{ tenantId: owner }]);
  });
});

describe("asAdminPlatform", () => {
  test("runs as platform for the capability holder, and is refused otherwise", async () => {
    expect(
      await withAdminRequest(async () =>
        scope.asAdminPlatform({ id: admin }, () => currentTenant()),
      ),
    ).toBe("platform");
    expect(() =>
      runAsTenant(admin, () =>
        scope.asAdminPlatform({ id: admin }, () => currentTenant()),
      ),
    ).toThrow(TenantContextError);
  });
});

describe("a credential sealed to team", () => {
  const store = createCredentialStore(database);
  const shared = {
    previousCredentialId: randomUUID(),
    kind: "mcp" as const,
    provider: "example",
    keyId: `${suite}-server`,
    metadata: {},
    encryptedValue: "never written",
    target: "team" as const,
  };

  async function statusOf(work: () => Promise<unknown>) {
    try {
      await work();
      return "written";
    } catch (error) {
      return error instanceof CredentialRefusedError
        ? error.status
        : String(error);
    }
  }

  test("is refused to an administrator's frame without the capability", async () => {
    expect(
      await runAsTenant(admin, () => statusOf(() => store.rotate(shared))),
    ).toBe(403);
    expect(
      await runAsTenant(admin, () =>
        statusOf(() => store.findLiveByKey(shared)),
      ),
    ).toBe(403);
    expect(
      await runAsTenant(admin, () =>
        statusOf(() =>
          store.revoke(shared.previousCredentialId, undefined, "team"),
        ),
      ),
    ).toBe(403);
  });

  test("is refused to a member", async () => {
    expect(
      await appFor({ id: member, role: "user" }, () =>
        statusOf(() => store.rotate(shared)),
      )(),
    ).toBe(403);
  });

  test("is refused for a kind that is not a server's secret, even with the capability", async () => {
    expect(
      await withAdminRequest(() =>
        statusOf(() => store.rotate({ ...shared, kind: "model" })),
      ),
    ).toBe(403);
  });

  test("with the capability, looks only at team rows", async () => {
    // No such team row: the lookup is allowed and finds nothing, rather than being refused.
    expect(
      await withAdminRequest(() => statusOf(() => store.rotate(shared))),
    ).toBe(404);
    expect(await withAdminRequest(() => store.findLiveByKey(shared))).toBe(
      null,
    );
  });

  test("with the capability, is allowed through an executor inside a transaction", async () => {
    // How the plugin store writes a server's secret: inside its own `database.transaction`, handing
    // the transaction to the credential store, which checks the capability inside the callback.
    const seen = await withAdminRequest(() =>
      onFreshDatabase((fresh) => {
        const freshStore = createCredentialStore(fresh);
        return fresh.transaction(async (transaction) => ({
          found: await freshStore.findLiveByKey(shared, transaction),
          rotated: await statusOf(() => freshStore.rotate(shared, transaction)),
        }));
      }),
    );
    expect(seen).toEqual({ found: null, rotated: 404 });
    // Without the capability the same shape is still refused.
    expect(
      await runAsTenant(admin, () =>
        onFreshDatabase((fresh) => {
          const freshStore = createCredentialStore(fresh);
          return fresh.transaction((transaction) =>
            statusOf(() => freshStore.rotate(shared, transaction)),
          );
        }),
      ),
    ).toBe(403);
  });
});
