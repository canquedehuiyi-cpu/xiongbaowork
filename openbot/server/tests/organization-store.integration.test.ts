import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createOrganizationAuth } from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  subscriptions,
  userInstructions,
  userRoles,
  users,
} from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** The identity layer and its tables are the deployment's, as `app.ts` runs them. */
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
});
afterAll(async () => {
  try {
    await releaseRoleWriter?.();
  } finally {
    await database.$client.close();
  }
});

test("verified employee keeps the same-email local account and history identity with the authority's current role", async () => {
  const localId = `local-${randomUUID()}`;
  const authorityId = `authority-${randomUUID()}`;
  const email = `employee-${randomUUID()}@example.test`;
  const channelId = `history-${randomUUID()}`;
  const history = "Existing employee instructions and history owner";
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        user: {
          id: authorityId,
          email,
          name: "Verified Employee",
          role: "user",
        },
      }),
  });
  try {
    // The identity tables carry no tenant, so they are seeded as the deployment's own...
    await asPlatform(async () => {
      await database.insert(users).values({
        id: localId,
        email,
        name: "Existing Employee",
        onboardingStep: 4,
        onboardingCompletedAt: new Date(),
      });
      await setRole(database, localId, "admin");
      await database
        .insert(userInstructions)
        .values({ userId: localId, instructions: history });
    });
    // ...and the conversation history is the employee's own, filed in their tenant.
    await runAsTenant(localId, async () => {
      await database.insert(channels).values({
        id: channelId,
        name: "Existing conversation",
        description: "Preserved",
        lastMessage: "Existing graphical Bot result",
      });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: localId });
    });
    const auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: organizationUserStore(database),
    });
    const cookie =
      "openbot.organization-session=" +
      Buffer.from(
        JSON.stringify({
          authority: authority.url.origin,
          cookie: "better-auth.session_token=fixture",
        }),
      ).toString("base64url");
    // Reached as `app.ts` reaches it: the identity layer runs as `platform`.
    const session = await asPlatform(() =>
      auth.api.getSession({
        headers: new Headers({ cookie }),
      }),
    );
    expect(session?.user).toMatchObject({ id: localId, email, role: "user" });
    expect(
      await asPlatform(() =>
        database.select().from(users).where(eq(users.email, email)),
      ),
    ).toHaveLength(1);
    expect(
      await asPlatform(() =>
        database.select().from(users).where(eq(users.id, authorityId)),
      ),
    ).toHaveLength(0);
    const [instructions] = await asPlatform(() =>
      database
        .select()
        .from(userInstructions)
        .where(eq(userInstructions.userId, localId)),
    );
    expect(instructions?.instructions).toBe(history);
    const [saved] = await asPlatform(() =>
      database.select().from(users).where(eq(users.id, localId)),
    );
    expect(
      (
        await runAsTenant(localId, () =>
          database
            .select()
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId)),
        )
      )[0]?.userId,
    ).toBe(localId);
    expect(
      (
        await runAsTenant(localId, () =>
          database.select().from(channels).where(eq(channels.id, channelId)),
        )
      )[0]?.lastMessage,
    ).toBe("Existing graphical Bot result");
    expect(saved?.onboardingStep).toBe(4);
    expect(saved?.onboardingCompletedAt).not.toBeNull();
    expect(
      (
        await asPlatform(() =>
          database
            .select()
            .from(userRoles)
            .where(eq(userRoles.userId, localId)),
        )
      ).map((row) => row.role),
    ).toEqual(["user"]);
    expect(
      (
        await asPlatform(() =>
          auth.api.getSession({ headers: new Headers({ cookie }) }),
        )
      )?.user.id,
    ).toBe(localId);

    /*
     * The organization path never passes through Better Auth's user-create hook, so it provisions the
     * tenant itself: one Free subscription row an administrator can switch, and the 分身. Quota reads
     * Free -- customModels false, so POST /api/models answers 402 until the plan is switched.
     */
    const owned = () =>
      runAsTenant(localId, async () => ({
        subscriptions: await database
          .select({
            planId: subscriptions.planId,
            status: subscriptions.status,
          })
          .from(subscriptions)
          .where(eq(subscriptions.tenantId, localId)),
        agents: await database
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.tenantId, localId)),
      }));
    expect(await owned()).toEqual({
      subscriptions: [{ planId: "free", status: "active" }],
      agents: [{ id: `avatar-${localId}` }],
    });
    const plan = await createQuotaService(database).planFor(localId);
    expect(plan.id).toBe("free");
    expect(plan.limits).toMatchObject({
      wakers: 2,
      tasksPerMonth: 50,
      devices: 1,
      customModels: false,
    });

    // A fresh store (a restarted process, so no in-memory memo) signing the same person in again
    // must not add a second subscription row: `subscriptions` has no unique key on the tenant.
    const restarted = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: organizationUserStore(database),
    });
    expect(
      (await restarted.api.getSession({ headers: new Headers({ cookie }) }))
        ?.user.id,
    ).toBe(localId);
    expect((await owned()).subscriptions).toHaveLength(1);
  } finally {
    authority.stop(true);
    await runAsTenant(localId, async () => {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, localId));
      await database.delete(agents).where(eq(agents.tenantId, localId));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, localId));
    });
    await runAsTenant(localId, () =>
      database.delete(channels).where(eq(channels.id, channelId)),
    );
    await asPlatform(async () => {
      await database.delete(users).where(eq(users.id, localId));
      await database.delete(users).where(eq(users.id, authorityId));
    });
  }
});
