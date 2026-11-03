import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { authFromConfiguration } from "../src/agents/auth-header";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  createAgentProfileStore,
  ManagedAgentUnavailableError,
  moveToTeam,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { DEPLOYMENT_ROUTES } from "../src/computer/deployment-routes";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  auditEvents,
  channelAgents,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const managedAgentAgUiUrl = new URL("https://managed.example.test/ag-ui");
const store: AgentProfileStore = createAgentProfileStore(
  database,
  managedAgentAgUiUrl,
);
const testPrefix = `agent-profile-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

/** A person's rows are written and read in that person's own frame, as their requests would be. */
const as = <T>(actor: AgentActor, fn: () => T): T => runAsTenant(actor.id, fn);
/** Deployment rows, and the cleanup that spans every tenant a test wrote to. */
const asPlatform = <T>(fn: () => T): T => runAsTenant("platform", fn);

/*
 * The admin pages (G01-E Q1). An administrator reaches another person's Bot only through the agent
 * routes' admin doors: the capability `adminCapability` grants after re-reading the role, a read as
 * `platform` (`asAdminPlatform`), and a write in the owner's frame (`adminActAsOwner`). Their own
 * frame, which their chat runtime and roster read in, shows them what it shows anybody.
 */
const adminScope = createAdminScope({
  roleRepository: { rolesForUser: async () => ["admin"] as never },
});
/*
 * The same doors as production builds them: `adminCapability` re-reads `user_roles`, so a session
 * that still says "admin" for somebody whose role was taken away holds no capability.
 */
const adminScopeFromRoles = createAdminScope({
  roleRepository: createRoleRepository(database),
});
const auditStore = createAuditStore(database);

function signedInAs(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { ...actor, email: `${actor.id}@example.test` });
    await runAsTenant(actor.id, () => next());
  };
}

/** One request to the agent routes, signed in as `actor`, with the admin doors mounted. */
function agentRequest(
  actor: AgentActor,
  method: "GET" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  scope: typeof adminScope = adminScope,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAgentRoutes(
      store,
      signedInAs(actor),
      false,
      auditStore,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      scope,
    ),
  );
  return app.request(`http://test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

/** `work` as the routes' admin read runs it: inside the request, holding the capability, as `platform`. */
async function onAdminPage<T>(
  admin: AgentActor,
  work: () => Promise<T>,
): Promise<T> {
  let value: T | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", signedInAs(admin), adminScope.adminCapability);
  app.get("/", async (context) => {
    value = await adminScope.asAdminPlatform(admin, work);
    return context.body(null, 204);
  });
  const response = await app.request("http://test/");
  expect(response.status).toBe(204);
  return value as T;
}

/** The stamps on a Bot's two rows, as `platform` sees them. */
async function stampsOf(agentId: string) {
  const [row] = await asPlatform(() =>
    database
      .select({ agent: agents.tenantId, profile: agentProfiles.tenantId })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agents.id, agentId)),
  );
  return row;
}

afterEach(async () => {
  await asPlatform(async () => {
    for (const channelId of createdChannelIds.splice(0)) {
      await database.delete(channels).where(eq(channels.id, channelId));
    }
    for (const agentId of createdAgentIds.splice(0)) {
      await database.delete(agents).where(eq(agents.id, agentId));
    }
    for (const packageId of createdPackageIds.splice(0)) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, packageId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await database.delete(users).where(eq(users.id, userId));
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});

function id(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

async function createUser(role: AgentActor["role"] = "user") {
  const userId = id("user");
  await runAsTenant(userId, () =>
    database.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Profile Store Test User",
    }),
  );
  createdUserIds.push(userId);
  return { id: userId, role } satisfies AgentActor;
}

async function createPackage() {
  const [deploymentPackage] = await asPlatform(() =>
    database
      .insert(deploymentPackages)
      .values({
        tenantId: id("tenant"),
        sourcePath: "test/profile-store",
        checksum: randomUUID(),
      })
      .returning(),
  );
  if (!deploymentPackage) throw new Error("Expected deployment package.");
  createdPackageIds.push(deploymentPackage.id);
  return deploymentPackage;
}

async function createProfileFixture(options: {
  owner: AgentActor | null;
  visibility?: "public" | "private";
  packageId?: string;
  name?: string;
  title?: string;
  roleDescription?: string;
  avatarSeed?: string;
  configuration?: Record<string, unknown>;
  /**
   * The frame to write in. The owner's frame for a person's Bot; a public one is then moved to
   * `team` by the owner, as the store moves it (G01-E P8b). Absent, the caller's frame.
   */
  frame?: string;
}) {
  if (options.frame !== undefined) {
    const { frame, ...rest } = options;
    return runAsTenant(frame, async () => {
      const seeded = await createProfileFixture(rest);
      if (rest.visibility === "public" && rest.owner?.id === frame) {
        await database.transaction((transaction) =>
          moveToTeam(transaction, seeded.agentId),
        );
      }
      return seeded;
    });
  }
  const agentId = id("seed-agent");
  const name = options.name ?? `Seed ${randomUUID()}`;
  const title = options.title ?? "Seed Assistant";
  const roleDescription = options.roleDescription ?? "Helps test profiles.";
  const avatarSeed = options.avatarSeed ?? `avatar-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name,
    type: "remote_ag_ui",
    configuration: options.configuration ?? {
      endpoint: "https://seed.example.test/ag-ui",
    },
    packageId: options.packageId,
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner?.id ?? null,
    title,
    roleDescription,
    avatarSeed,
    visibility: options.visibility ?? "private",
  });
  return { agentId, name, title, roleDescription, avatarSeed };
}

async function profileById(
  actor: AgentActor,
  agentId: string,
  frame = actor.id,
) {
  const profile = await runAsTenant(frame, () => store.get(actor, agentId));
  if (!profile) throw new Error(`Expected visible profile ${agentId}.`);
  return profile;
}

function expectListed(
  profiles: AgentProfile[],
  agentId: string,
  expected: boolean,
) {
  expect(profiles.some((profile) => profile.id === agentId)).toBe(expected);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForMutationBlock(
  applicationName: string,
  mutationSettled: () => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const blockedSessions = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blockedSessions.length > 0) return true;
    if (mutationSettled()) return false;
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

async function racePackageAttachment(
  agentId: string,
  packageId: string,
  mutate: (namedStore: AgentProfileStore) => Promise<unknown>,
) {
  const applicationName = `profile_store_lock_${randomUUID()}`;
  const namedDatabaseUrl = new URL(databaseUrl);
  namedDatabaseUrl.searchParams.set("application_name", applicationName);
  const namedDatabase = createDatabase(namedDatabaseUrl.toString(), TEST_POOL);
  const namedStore = createAgentProfileStore(
    namedDatabase,
    managedAgentAgUiUrl,
  );
  const writeAcquired = deferred();
  const releaseAttachment = deferred();
  const attachment = database.transaction(async (transaction) => {
    await transaction
      .update(agents)
      .set({ packageId })
      .where(eq(agents.id, agentId));
    writeAcquired.resolve();
    await releaseAttachment.promise;
  });
  void attachment.catch(writeAcquired.reject);

  try {
    await writeAcquired.promise;
    let settled = false;
    const outcomePromise = mutate(namedStore).then(
      (value) => {
        settled = true;
        return { status: "fulfilled", value } as const;
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: "rejected" } as const;
      },
    );
    const blocked = await waitForMutationBlock(applicationName, () => settled);
    releaseAttachment.resolve();
    await attachment;
    return { blocked, outcome: await outcomePromise };
  } finally {
    releaseAttachment.resolve();
    await attachment.catch(() => undefined);
    await namedDatabase.$client.close();
  }
}

/**
 * The stored row behind a coworker, proven to exist before anything reads it.
 *
 * Asserted here rather than at each call site because a missing row and a missing field are
 * different failures that an optional chain would collapse into the same one — "systemPrompt is
 * undefined" reads as a prompt that was not written when it may be a coworker that is not there.
 */
async function agentRow(agentId: string): Promise<{
  type: string;
  configuration: { systemPrompt?: string; endpoint?: string };
}> {
  const [row] = await database
    .select({ type: agents.type, configuration: agents.configuration })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) throw new Error(`no agents row for ${agentId}`);
  return {
    type: row.type,
    configuration: (row.configuration ?? {}) as {
      systemPrompt?: string;
      endpoint?: string;
    },
  };
}

describe("agent profile store integration", () => {
  test("refuses to create a coworker with no endpoint when this deployment has no managed Bot", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const withoutManaged = createAgentProfileStore(database, undefined);

      await expect(
        withoutManaged.create(owner, {
          name: "No Endpoint",
          title: "Needs an address",
          roleDescription: "Should not land on a missing Bot.",
          visibility: "private",
        }),
      ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
    });
  });

  /**
   * The coworker with nowhere to send it, and the instruction it actually runs on.
   *
   * `registeredAgentFromRow` gives a `built_in` agent its `configuration.systemPrompt` and NO
   * standing role message, so that column is the whole of what such a coworker is ever told —
   * `agentProfiles.roleDescription` never reaches it. These two tests exist because the pair can
   * drift silently: creating writes both, and an edit that wrote only the profile left every screen
   * showing new instructions while the Bot went on following the old ones, for good, with nothing
   * anywhere to say so.
   */
  test("creates a coworker that runs here when there is nowhere to send it", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const withoutManaged = createAgentProfileStore(database, undefined);

      const created = await withoutManaged.create(owner, {
        name: "Runs Here",
        title: "Everyday Work",
        roleDescription: "Answer from the ledger and quote the line you used.",
        visibility: "private",
        systemPrompt: "Answer from the ledger and quote the line you used.",
      });
      createdAgentIds.push(created.id);

      const row = await agentRow(created.id);
      expect(row.type).toBe("built_in");
      expect(row.configuration.systemPrompt).toBe(
        "Answer from the ledger and quote the line you used.",
      );
      // No address was given and none was invented; that is what makes it built_in rather than remote.
      expect(row.configuration.endpoint).toBeUndefined();
    });
  });

  test("an edit moves the instruction such a coworker actually runs on", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const withoutManaged = createAgentProfileStore(database, undefined);
      const created = await withoutManaged.create(owner, {
        name: "Runs Here",
        title: "Everyday Work",
        roleDescription: "The first instruction.",
        visibility: "private",
        systemPrompt: "The first instruction.",
      });
      createdAgentIds.push(created.id);

      await withoutManaged.update(owner, created.id, {
        name: "Runs Here",
        title: "Everyday Work",
        roleDescription: "The second instruction, which must be the live one.",
        visibility: "private",
      });

      const row = await agentRow(created.id);
      expect(row.type).toBe("built_in");
      expect(row.configuration.systemPrompt).toBe(
        "The second instruction, which must be the live one.",
      );
      // And the profile every screen reads agrees with it, rather than only the profile moving.
      expect((await profileById(owner, created.id)).roleDescription).toBe(
        "The second instruction, which must be the live one.",
      );
    });
  });

  /**
   * The other half of the same rule: a remote coworker must not acquire a prompt it never had.
   *
   * Its instruction travels as the standing role message built from the profile, so a `systemPrompt`
   * appearing in its configuration would be a second source for the same thing — and the one the
   * runtime prefers for a `built_in` row, which is what this coworker would look like if its type
   * ever changed.
   */
  test("an edit never gives a coworker at its own address a system prompt", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        visibility: "private",
        configuration: { endpoint: "https://remote.example.test/ag-ui" },
      });

      await store.update(owner, source.agentId, {
        name: "Still Remote",
        title: "Elsewhere",
        roleDescription: "Edited, and it still runs at its own address.",
        visibility: "private",
        endpoint: "https://remote.example.test/ag-ui",
      });

      const row = await agentRow(source.agentId);
      expect(row.type).toBe("remote_ag_ui");
      expect(row.configuration.systemPrompt).toBeUndefined();
    });
  });

  test("lets an owner get and list a private profile, and an admin on the admin pages only, but hides it from another user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      frame: owner.id,
    });

    expect((await profileById(owner, source.agentId)).id).toBe(source.agentId);
    // The admin pages: the route's own read, and the same read through the route helper.
    const response = await agentRequest(admin, "GET", `/${source.agentId}`);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { agent: { id: string } }).agent.id,
    ).toBe(source.agentId);
    expect(
      (await onAdminPage(admin, () => store.get(admin, source.agentId)))?.id,
    ).toBe(source.agentId);
    expectListed(
      await onAdminPage(admin, () => store.list(admin)),
      source.agentId,
      true,
    );
    // The admin's own frame, which their chat runtime and roster read in, does not show it (Q1).
    expect(await as(admin, () => store.get(admin, source.agentId))).toBeNull();
    expectListed(
      await as(admin, () => store.list(admin)),
      source.agentId,
      false,
    );
    expect(await as(other, () => store.get(other, source.agentId))).toBeNull();
    expectListed(
      await as(owner, () => store.list(owner)),
      source.agentId,
      true,
    );
    expectListed(
      await as(other, () => store.list(other)),
      source.agentId,
      false,
    );
    expect(await stampsOf(source.agentId)).toEqual({
      agent: owner.id,
      profile: owner.id,
    });
  });

  test("stores hiding per user and moves the caller between default and hidden lists", async () => {
    const owner = await createUser();
    const other = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "public",
      frame: owner.id,
    });
    expect(await stampsOf(source.agentId)).toEqual({
      agent: "team",
      profile: "team",
    });
    // Each person in their own frame, as their requests run.
    const listOf = (actor: AgentActor, hidden?: boolean) =>
      as(actor, () => store.list(actor, hidden));

    expectListed(await listOf(owner), source.agentId, true);
    expectListed(await listOf(owner, true), source.agentId, false);
    expectListed(await listOf(other), source.agentId, true);

    await as(owner, () => store.setHidden(owner, source.agentId, true));
    expectListed(await listOf(owner), source.agentId, false);
    expectListed(await listOf(owner, true), source.agentId, true);
    expectListed(await listOf(other), source.agentId, true);
    expectListed(await listOf(other, true), source.agentId, false);

    await as(owner, () => store.setHidden(owner, source.agentId, false));
    expectListed(await listOf(owner), source.agentId, true);
    expectListed(await listOf(owner, true), source.agentId, false);
    const preferenceOf = () =>
      database
        .select()
        .from(agentPreferences)
        .where(
          and(
            eq(agentPreferences.userId, owner.id),
            eq(agentPreferences.agentId, source.agentId),
          ),
        );
    const [preference] = await as(owner, preferenceOf);
    expect(preference?.hiddenAt).toBeNull();
    // The preference is the person's own, even on a team Bot, and nobody else reads it.
    expect(preference?.tenantId).toBe(owner.id);
    expect(await as(other, preferenceOf)).toEqual([]);
  });

  test("stores pinning per user, independently of hiding", async () => {
    const owner = await createUser();
    const other = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "public",
      frame: owner.id,
    });
    expect(await stampsOf(source.agentId)).toEqual({
      agent: "team",
      profile: "team",
    });
    // `profileById` reads in the actor's own frame.
    const pinnedFor = async (actor: AgentActor) =>
      (await profileById(actor, source.agentId)).pinned;
    const asOwner = <T>(fn: () => T) => as(owner, fn);

    expect(await pinnedFor(owner)).toBe(false);

    await asOwner(() => store.setPinned(owner, source.agentId, true));
    expect(await pinnedFor(owner)).toBe(true);
    expect(await pinnedFor(other)).toBe(false);

    // The same preference row as hiding: each write must leave the other column alone.
    await asOwner(() => store.setHidden(owner, source.agentId, true));
    const [hiddenWhilePinned] = await asOwner(() => store.list(owner, true));
    expect(hiddenWhilePinned?.pinned).toBe(true);
    await asOwner(() => store.setPinned(owner, source.agentId, false));
    await asOwner(() => store.setPinned(owner, source.agentId, true));
    expectListed(
      await asOwner(() => store.list(owner, true)),
      source.agentId,
      true,
    );

    await asOwner(() => store.setHidden(owner, source.agentId, false));
    expect(await pinnedFor(owner)).toBe(true);
    await asOwner(() => store.setPinned(owner, source.agentId, false));
    expect(await pinnedFor(owner)).toBe(false);
    const preferenceOf = () =>
      database
        .select()
        .from(agentPreferences)
        .where(
          and(
            eq(agentPreferences.userId, owner.id),
            eq(agentPreferences.agentId, source.agentId),
          ),
        );
    const [preference] = await asOwner(preferenceOf);
    expect(preference?.pinnedAt).toBeNull();
    expect(preference?.hiddenAt).toBeNull();
    expect(preference?.tenantId).toBe(owner.id);
    expect(await as(other, preferenceOf)).toEqual([]);
  });

  test("refuses to pin a coworker the caller cannot see", async () => {
    const owner = await createUser();
    const other = await createUser();
    const privateSource = await as(owner, () =>
      createProfileFixture({
        owner,
        visibility: "private",
      }),
    );

    await expect(
      as(other, () => store.setPinned(other, privateSource.agentId, true)),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    // Also in the platform's frame, which sees the private row: the store itself must refuse.
    await expect(
      asPlatform(() => store.setPinned(other, privateSource.agentId, true)),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("takes the endpoint and ignores every field a caller must not set", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const deploymentPackage = await createPackage();
      const source = await createProfileFixture({
        owner,
        visibility: "private",
        configuration: { endpoint: "https://preserved.example.test/ag-ui" },
      });
      const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
      await database
        .update(agents)
        .set({ updatedAt: oldTimestamp })
        .where(eq(agents.id, source.agentId));
      await database
        .update(agentProfiles)
        .set({ updatedAt: oldTimestamp })
        .where(eq(agentProfiles.agentId, source.agentId));

      const result = await store.update(owner, source.agentId, {
        name: "Renamed Assistant",
        title: "Updated Title",
        roleDescription: "Updated role description.",
        visibility: "public",
        id: "forged-id",
        // The endpoint IS editable, and is the one field in this hostile payload that lands. A service
        // moves host, and the alternative is deleting the coworker and losing its conversations. It
        // reaches here already validated by the same check that guards creation.
        endpoint: "https://moved.example.test/ag-ui",
        ownerUserId: "forged-owner",
        avatarSeed: "forged-avatar",
        packageId: deploymentPackage.id,
        deletedAt: new Date(),
      } as unknown as CreateAgentInput);

      expect(result).toMatchObject({
        id: source.agentId,
        name: "Renamed Assistant",
        title: "Updated Title",
        roleDescription: "Updated role description.",
        visibility: "public",
        ownerUserId: owner.id,
        avatarSeed: source.avatarSeed,
        systemOwned: false,
        deletedAt: null,
      });
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, source.agentId));
      const [profile] = await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, source.agentId));
      expect(canonical).toMatchObject({
        id: source.agentId,
        name: "Renamed Assistant",
        type: "remote_ag_ui",
        configuration: { endpoint: "https://moved.example.test/ag-ui" },
        packageId: null,
      });
      expect(profile).toMatchObject({
        ownerUserId: owner.id,
        title: "Updated Title",
        roleDescription: "Updated role description.",
        avatarSeed: source.avatarSeed,
        visibility: "public",
        deletedAt: null,
      });
      expect(canonical?.updatedAt.getTime()).toBeGreaterThan(
        oldTimestamp.getTime(),
      );
      expect(profile?.updatedAt.getTime()).toBeGreaterThan(
        oldTimestamp.getTime(),
      );
    });
  });

  test("rejects public non-owner mutation as unmanageable and inaccessible private mutation as absent", async () => {
    const owner = await createUser();
    const other = await createUser();
    const publicSource = await createProfileFixture({
      owner,
      visibility: "public",
      frame: owner.id,
    });
    const privateSource = await createProfileFixture({
      owner,
      visibility: "private",
      frame: owner.id,
    });
    const input: CreateAgentInput = {
      name: "Other Name",
      title: "Other Title",
      roleDescription: "Other role.",
      visibility: "public",
    };
    const asOther = <T>(fn: () => T) => as(other, fn);

    await expect(
      asOther(() => store.update(other, publicSource.agentId, input)),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await asOther(() => store.setHidden(other, publicSource.agentId, true));
    expectListed(
      await asOther(() => store.list(other)),
      publicSource.agentId,
      false,
    );
    expectListed(
      await asOther(() => store.list(other, true)),
      publicSource.agentId,
      true,
    );
    await expect(
      asOther(() => store.update(other, privateSource.agentId, input)),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      asOther(() => store.setHidden(other, privateSource.agentId, true)),
    ).rejects.toBeInstanceOf(AgentNotFoundError);

    // Past the store, straight at the table: the other person's frame changes neither Bot.
    for (const agentId of [publicSource.agentId, privateSource.agentId]) {
      const written = await asOther(() =>
        database
          .update(agentProfiles)
          .set({ title: "Taken" })
          .where(eq(agentProfiles.agentId, agentId))
          .returning({ agentId: agentProfiles.agentId }),
      );
      expect(written).toEqual([]);
    }
    // Nor may the owner re-stamp their team Bot by hand: only the explicit move does that.
    let restamp: unknown;
    try {
      await as(owner, () =>
        database
          .update(agentProfiles)
          .set({ tenantId: other.id })
          .where(eq(agentProfiles.agentId, publicSource.agentId)),
      );
    } catch (error) {
      restamp = error;
    }
    expect(restamp).toBeDefined();
    /*
     * The stamp above (`other.id`) would be refused even with the move's GUC set, so it alone does not
     * show the GUC is what decides. Back to the owner's own tenant: refused without `app.team_move`,
     * admitted with it (the explicit move), and then put back the same way.
     */
    let toOwnerWithoutMove: unknown;
    try {
      await as(owner, () =>
        database
          .update(agentProfiles)
          .set({ tenantId: owner.id })
          .where(eq(agentProfiles.agentId, publicSource.agentId)),
      );
    } catch (error) {
      toOwnerWithoutMove = error;
    }
    expect(toOwnerWithoutMove).toBeDefined();
    expect(await stampsOf(publicSource.agentId)).toEqual({
      agent: "team",
      profile: "team",
    });
    /*
     * With the GUC, inside a transaction that is then rolled back: the profile alone back to the owner
     * would leave the `agents` row `team` and, for the owner, unreadable (its `team_read` asks whether
     * the profile is `team`), a half move only `platform` could repair. The store moves both together.
     */
    const rollback = new Error("roll the explicit move back");
    let underMove: unknown;
    await expect(
      as(owner, () =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.team_move', ${publicSource.agentId}, true)`,
          );
          underMove = await tx
            .update(agentProfiles)
            .set({ tenantId: owner.id })
            .where(eq(agentProfiles.agentId, publicSource.agentId))
            .returning({ tenantId: agentProfiles.tenantId });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
    expect(underMove).toEqual([{ tenantId: owner.id }]);
    expect(await stampsOf(publicSource.agentId)).toEqual({
      agent: "team",
      profile: "team",
    });
    expect(await stampsOf(privateSource.agentId)).toEqual({
      agent: owner.id,
      profile: owner.id,
    });
    const titles = await asPlatform(() =>
      database
        .select({ title: agentProfiles.title })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, owner.id)),
    );
    expect(titles.map((row) => row.title)).not.toContain("Taken");
  });

  test("rejects update and soft delete for a package-backed profile", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const deploymentPackage = await createPackage();
      const source = await createProfileFixture({
        owner,
        packageId: deploymentPackage.id,
      });
      const input: CreateAgentInput = {
        name: "Protected Rename",
        title: "Protected Title",
        roleDescription: "Protected role.",
        visibility: "public",
      };

      const profile = await profileById(owner, source.agentId);
      expect(profile.systemOwned).toBe(true);
      await expect(
        store.update(owner, source.agentId, input),
      ).rejects.toBeInstanceOf(ProtectedAgentError);
      await expect(
        store.softDelete(owner, source.agentId),
      ).rejects.toBeInstanceOf(ProtectedAgentError);
    });
  });

  test("serializes update authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const deploymentPackage = await createPackage();
      const source = await createProfileFixture({
        owner,
        name: "Original Name",
        title: "Original Title",
        roleDescription: "Original role.",
      });

      const { blocked, outcome } = await racePackageAttachment(
        source.agentId,
        deploymentPackage.id,
        (namedStore) =>
          namedStore.update(owner, source.agentId, {
            name: "Racing Rename",
            title: "Racing Title",
            roleDescription: "Racing role.",
            visibility: "public",
          }),
      );

      expect(outcome.status).toBe("rejected");
      expect(blocked).toBe(true);
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
      }
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, source.agentId));
      const [profile] = await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, source.agentId));
      expect(canonical?.name).toBe(source.name);
      expect(canonical?.packageId).toBe(deploymentPackage.id);
      expect(profile).toMatchObject({
        deletedAt: null,
        roleDescription: source.roleDescription,
        title: source.title,
        visibility: "private",
      });
    });
  });

  test("serializes soft-delete authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const deploymentPackage = await createPackage();
      const source = await createProfileFixture({ owner });

      const { blocked, outcome } = await racePackageAttachment(
        source.agentId,
        deploymentPackage.id,
        (namedStore) => namedStore.softDelete(owner, source.agentId),
      );

      expect(outcome.status).toBe("rejected");
      expect(blocked).toBe(true);
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
      }
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, source.agentId));
      const [profile] = await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, source.agentId));
      expect(canonical?.packageId).toBe(deploymentPackage.id);
      expect(profile?.deletedAt).toBeNull();
    });
  });

  test("allows an admin to update and soft delete a user-owned profile", async () => {
    const owner = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner, frame: owner.id });
    const input: CreateAgentInput = {
      name: "Admin Rename",
      title: "Admin Title",
      roleDescription: "Admin role update.",
      visibility: "private",
    };

    // In their own frame, the admin cannot even find it (Q1).
    await expect(
      as(admin, () => store.update(admin, source.agentId, input)),
    ).rejects.toBeInstanceOf(AgentNotFoundError);

    // The admin page: found as `platform`, changed in the owner's frame (`adminActAsOwner`).
    const response = await agentRequest(
      admin,
      "PATCH",
      `/${source.agentId}`,
      input,
    );
    expect(response.status).toBe(200);
    const { agent: updated } = (await response.json()) as {
      agent: Record<string, unknown>;
    };
    expect(updated).toMatchObject({
      name: "Admin Rename",
      title: "Admin Title",
      mine: false,
    });
    const [profile] = await asPlatform(() =>
      database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, source.agentId)),
    );
    expect(profile).toMatchObject({
      ownerUserId: owner.id,
      title: "Admin Title",
      tenantId: owner.id,
    });
    // The trail row is the owner's, written in the owner's frame, naming the admin who acted.
    const trail = async (eventType: string) =>
      asPlatform(() =>
        database
          .select({
            tenantId: auditEvents.tenantId,
            actorUserId: auditEvents.actorUserId,
          })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetId, source.agentId),
              eq(auditEvents.eventType, eventType),
            ),
          ),
      );
    expect(await trail("bot.updated")).toEqual([
      { tenantId: owner.id, actorUserId: admin.id },
    ]);

    const deleted = await agentRequest(admin, "DELETE", `/${source.agentId}`);
    expect(deleted.status).toBe(204);
    expect(await trail("bot.deleted")).toEqual([
      { tenantId: owner.id, actorUserId: admin.id },
    ]);
    expect(
      await onAdminPage(admin, () => store.get(admin, source.agentId)),
    ).toBeNull();
    expect(await as(owner, () => store.get(owner, source.agentId))).toBeNull();
    expect(
      (await agentRequest(admin, "GET", `/${source.agentId}`)).status,
    ).toBe(404);
  });

  test("an admin whose role was taken away holds no admin door, though the session still says admin", async () => {
    const owner = await createUser();
    const demoted = await createUser("admin");
    const admin = await createUser("admin");
    const privateSource = await createProfileFixture({
      owner,
      frame: owner.id,
    });
    const publicSource = await createProfileFixture({
      owner,
      visibility: "public",
      frame: owner.id,
    });
    const input: CreateAgentInput = {
      name: "Demoted Rename",
      title: "Demoted Title",
      roleDescription: "Demoted role update.",
      visibility: "public",
    };
    const releaseRoleWriter = await bindTestRoleWriter(database);
    try {
      // Only `admin` holds the role in `user_roles`; `demoted`'s session is all that says admin.
      await asPlatform(() => setRole(database, admin.id, "admin"));
      const request = (
        actor: AgentActor,
        method: "GET" | "PATCH" | "DELETE",
        agentId: string,
      ) =>
        agentRequest(
          actor,
          method,
          `/${agentId}`,
          method === "PATCH" ? input : undefined,
          adminScopeFromRoles,
        );

      // The same doors, read from the table, open for the administrator who holds the role.
      expect((await request(admin, "GET", privateSource.agentId)).status).toBe(
        200,
      );
      // Somebody else's private Bot: as for anyone, not there.
      for (const method of ["GET", "PATCH", "DELETE"] as const)
        expect(
          (await request(demoted, method, privateSource.agentId)).status,
        ).toBe(404);
      // A team Bot they can see: the session's role gets past the store's check, and the write is
      // still refused, because only the owner's frame (or `platform`, which they cannot open) writes it.
      expect(
        (await request(demoted, "PATCH", publicSource.agentId)).status,
      ).toBe(403);
      expect(
        (await request(demoted, "DELETE", publicSource.agentId)).status,
      ).toBe(403);

      const rows = await asPlatform(() =>
        database
          .select({
            title: agentProfiles.title,
            visibility: agentProfiles.visibility,
            deletedAt: agentProfiles.deletedAt,
          })
          .from(agentProfiles)
          .where(eq(agentProfiles.ownerUserId, owner.id)),
      );
      expect(rows.map((row) => row.title)).not.toContain("Demoted Title");
      expect(rows.every((row) => row.deletedAt === null)).toBe(true);
      expect(await stampsOf(privateSource.agentId)).toEqual({
        agent: owner.id,
        profile: owner.id,
      });
    } finally {
      await releaseRoleWriter();
    }
  });

  test("an admin on the admin pages manages a Bot whose owner was deleted, as `platform`", async () => {
    const owner = await createUser();
    const member = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({
      owner,
      visibility: "public",
      frame: owner.id,
    });
    // The owner's account goes; the profile's owner is set null by the foreign key.
    await asPlatform(() =>
      database.delete(users).where(eq(users.id, owner.id)),
    );
    const profileRow = async () =>
      (
        await asPlatform(() =>
          database
            .select({
              ownerUserId: agentProfiles.ownerUserId,
              tenantId: agentProfiles.tenantId,
              title: agentProfiles.title,
              deletedAt: agentProfiles.deletedAt,
            })
            .from(agentProfiles)
            .where(eq(agentProfiles.agentId, source.agentId)),
        )
      )[0];
    expect(await profileRow()).toMatchObject({
      ownerUserId: null,
      tenantId: "team",
      deletedAt: null,
    });
    const input: CreateAgentInput = {
      name: "Orphan Rename",
      title: "Orphan Title",
      roleDescription: "Orphan role update.",
      visibility: "public",
    };

    // Everybody still sees it; nobody's own frame can change it.
    expect(
      (await agentRequest(member, "GET", `/${source.agentId}`)).status,
    ).toBe(200);
    expect(
      (await agentRequest(member, "PATCH", `/${source.agentId}`, input)).status,
    ).toBe(403);
    expect(
      (await agentRequest(member, "DELETE", `/${source.agentId}`)).status,
    ).toBe(403);
    await expect(
      as(admin, () => store.update(admin, source.agentId, input)),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    expect((await profileRow())?.title).toBe("Seed Assistant");

    // The admin page: found and changed as `platform`, the trail row naming the admin who acted.
    const response = await agentRequest(
      admin,
      "PATCH",
      `/${source.agentId}`,
      input,
    );
    expect(response.status).toBe(200);
    expect(await profileRow()).toMatchObject({
      ownerUserId: null,
      tenantId: "team",
      title: "Orphan Title",
    });
    const trail = (eventType: string) =>
      asPlatform(() =>
        database
          .select({
            tenantId: auditEvents.tenantId,
            actorUserId: auditEvents.actorUserId,
          })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetId, source.agentId),
              eq(auditEvents.eventType, eventType),
            ),
          ),
      );
    expect(await trail("bot.updated")).toEqual([
      { tenantId: "platform", actorUserId: admin.id },
    ]);

    const deleted = await agentRequest(admin, "DELETE", `/${source.agentId}`);
    expect(deleted.status).toBe(204);
    expect((await profileRow())?.deletedAt).not.toBeNull();
    expect(await trail("bot.deleted")).toEqual([
      { tenantId: "platform", actorUserId: admin.id },
    ]);
    expect(
      (await agentRequest(member, "GET", `/${source.agentId}`)).status,
    ).toBe(404);
  });

  test("duplicates a profile as a caller-owned private agent with copied presentation fields", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        visibility: "public",
        name: "Source Name",
        title: "Source Title",
        roleDescription: "Source role.",
        avatarSeed: "source-avatar",
      });
      await store.setHidden(owner, source.agentId, true);

      const duplicate = await store.duplicate(owner, source.agentId);

      expect(duplicate.id).toMatch(
        /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(duplicate).toMatchObject({
        name: source.name,
        title: source.title,
        roleDescription: source.roleDescription,
        avatarSeed: source.avatarSeed,
        visibility: "private",
        ownerUserId: owner.id,
        systemOwned: false,
        hidden: false,
        deletedAt: null,
      });
      expect(duplicate.id).not.toBe(source.agentId);
      createdAgentIds.push(duplicate.id);
      const duplicatePreferences = await database
        .select()
        .from(agentPreferences)
        .where(eq(agentPreferences.agentId, duplicate.id));
      expect(duplicatePreferences).toHaveLength(0);
    });
  });

  test("duplicates no channel membership or Intelligence mapping from the source", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        visibility: "public",
      });
      const channelId = id("channel");
      await database.insert(channels).values({
        id: channelId,
        name: "Source channel",
        description: "Links source agent to Intelligence.",
      });
      await database.insert(channelAgents).values({
        channelId,
        agentId: source.agentId,
      });
      await database.insert(intelligenceChannelMappings).values({
        userId: owner.id,
        channelId,
        threadId: id("thread"),
      });
      createdChannelIds.push(channelId);

      const duplicate = await store.duplicate(owner, source.agentId);
      createdAgentIds.push(duplicate.id);

      const sourceMappings = await database
        .select()
        .from(channelAgents)
        .innerJoin(
          intelligenceChannelMappings,
          eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
        )
        .where(eq(channelAgents.agentId, source.agentId));
      const duplicateMappings = await database
        .select()
        .from(channelAgents)
        .innerJoin(
          intelligenceChannelMappings,
          eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
        )
        .where(eq(channelAgents.agentId, duplicate.id));
      const duplicateChannelAgents = await database
        .select()
        .from(channelAgents)
        .where(eq(channelAgents.agentId, duplicate.id));
      expect(sourceMappings).not.toHaveLength(0);
      expect(duplicateChannelAgents).toHaveLength(0);
      expect(duplicateMappings).toHaveLength(0);
    });
  });

  test("copies the source's own endpoint rather than repointing the copy at the managed Bot", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        configuration: { endpoint: "https://hosted.example.test/ag-ui" },
      });

      const duplicate = await store.duplicate(owner, source.agentId);
      createdAgentIds.push(duplicate.id);

      expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
      expect(duplicate.endpoint).not.toBe(managedAgentAgUiUrl.toString());
    });
  });

  test("gives a copy of an endpoint-less source the managed Bot, as its source had", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const created = await store.create(owner, {
        name: `Created ${randomUUID()}`,
        title: "Created Title",
        roleDescription: "Created role description.",
        visibility: "private",
      } as CreateAgentInput);
      createdAgentIds.push(created.id);

      const duplicate = await store.duplicate(owner, created.id);
      createdAgentIds.push(duplicate.id);

      expect(duplicate.endpoint).toBe(managedAgentAgUiUrl.toString());
    });
  });

  test("does not carry the source's stored key onto the copy", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        configuration: {
          endpoint: "https://hosted.example.test/ag-ui",
          auth: { header: "Authorization", credentialId: "credential-1" },
        },
      });
      expect((await profileById(owner, source.agentId)).hasAuth).toBe(true);

      const duplicate = await store.duplicate(owner, source.agentId);
      createdAgentIds.push(duplicate.id);

      expect(duplicate.hasAuth).toBe(false);
      const [row] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, duplicate.id));
      expect(authFromConfiguration(row?.configuration)).toBeNull();
    });
  });

  test("duplicates a coworker with its own endpoint on a deployment with no managed Bot", async () => {
    const unmanagedStore = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        configuration: { endpoint: "https://hosted.example.test/ag-ui" },
      });

      const duplicate = await unmanagedStore.duplicate(owner, source.agentId);
      createdAgentIds.push(duplicate.id);

      expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
    });
  });

  test("refuses to duplicate an endpoint-less coworker with no managed Bot to fall back to", async () => {
    const unmanagedStore = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        configuration: {},
      });

      await expect(
        unmanagedStore.duplicate(owner, source.agentId),
      ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
    });
  });

  test("soft deletes a profile from reads and lists while retaining its raw rows", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const source = await createProfileFixture({
        owner,
        visibility: "public",
      });

      await store.softDelete(owner, source.agentId);

      expect(await store.get(owner, source.agentId)).toBeNull();
      expectListed(await store.list(owner), source.agentId, false);
      expectListed(await store.list(owner, true), source.agentId, false);
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, source.agentId));
      const [profile] = await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, source.agentId));
      expect(canonical?.id).toBe(source.agentId);
      expect(profile?.agentId).toBe(source.agentId);
      expect(profile?.deletedAt).toBeInstanceOf(Date);
      await expect(
        store.setHidden(owner, source.agentId, true),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    });
  });

  test("rolls back canonical creation when the profile insert fails", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const name = `Rollback ${randomUUID()}`;

      await expect(
        store.create(owner, {
          name,
          title: null,
          roleDescription: "This profile insert must fail.",
          visibility: "public",
        } as unknown as CreateAgentInput),
      ).rejects.toThrow();
      const rows = await database
        .select()
        .from(agents)
        .where(eq(agents.name, name));
      expect(rows).toHaveLength(0);
    });
  });

  /*
   * The id a caller gets is never one they chose.
   *
   * The reserved-id checks in `tenant-package.ts` rest on this: a package is the only place a Bot id
   * is written by a person, so refusing the reserved names there closes them everywhere. The day
   * this route lets a caller name their own Bot, that stops being true, and this is the test that
   * says so rather than the reader who happens to notice.
   */
  test("mints its own id rather than taking one, for a create and for a copy", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const created = await store.create(owner, {
        name: `Created ${randomUUID()}`,
        title: "Created Title",
        roleDescription: "Created role description.",
        visibility: "private",
      } as CreateAgentInput);
      createdAgentIds.push(created.id);
      const copy = await store.duplicate(owner, created.id);
      createdAgentIds.push(copy.id);

      for (const id of [created.id, copy.id]) {
        expect(id).toMatch(
          /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(DEPLOYMENT_ROUTES.has(id)).toBe(false);
      }
    });
  });

  test("creates a caller-owned remote AG-UI profile with the requested visibility", async () => {
    const owner = await createUser();
    await as(owner, async () => {
      const input: CreateAgentInput = {
        name: `Created ${randomUUID()}`,
        title: "Created Title",
        roleDescription: "Created role description.",
        visibility: "public",
      };

      const created = await store.create(owner, input);
      createdAgentIds.push(created.id);

      expect(created).toMatchObject({
        name: input.name,
        title: input.title,
        roleDescription: input.roleDescription,
        avatarSeed: created.id,
        visibility: "public",
        ownerUserId: owner.id,
        systemOwned: false,
        hidden: false,
        deletedAt: null,
      });
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, created.id));
      expect(canonical).toMatchObject({
        id: created.id,
        name: input.name,
        type: "remote_ag_ui",
        configuration: { endpoint: managedAgentAgUiUrl.toString() },
        packageId: null,
      });
    });
  });
});
