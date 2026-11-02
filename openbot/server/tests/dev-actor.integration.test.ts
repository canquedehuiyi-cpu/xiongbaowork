import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  DEV_ACTOR,
  initializeDevActorUser,
  provisionDevActorTenant,
} from "../src/auth/dev-actor";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, subscriptions, users } from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

describe("development actor persistence", () => {
  test("does not access the database when disabled", async () => {
    const inaccessibleDatabase = {
      get insert(): never {
        throw new Error("disabled initialization accessed the database");
      },
    };

    expect(await initializeDevActorUser(inaccessibleDatabase, false)).toBe(
      false,
    );
  });

  test("writes only when enabled and restores the canonical user identity", async () => {
    const rollback = new Error("rollback development actor test");

    // The development actor's own row, so its own frame.
    await expect(
      runAsTenant(DEV_ACTOR.id, () =>
        database.transaction(async (transaction) => {
          await transaction.delete(users).where(eq(users.id, DEV_ACTOR.id));

          expect(await initializeDevActorUser(transaction, false)).toBe(false);
          expect(
            await transaction
              .select()
              .from(users)
              .where(eq(users.id, DEV_ACTOR.id)),
          ).toEqual([]);

          expect(await initializeDevActorUser(transaction, true)).toBe(true);
          const firstRows = await transaction
            .select()
            .from(users)
            .where(eq(users.id, DEV_ACTOR.id));
          expect(firstRows).toHaveLength(1);
          expect(firstRows[0]).toMatchObject({
            id: DEV_ACTOR.id,
            email: DEV_ACTOR.email,
            name: DEV_ACTOR.name ?? DEV_ACTOR.email,
            emailVerified: false,
            groups: [],
            createdAt: expect.any(Date),
            updatedAt: expect.any(Date),
          });

          await transaction
            .update(users)
            .set({
              email: `changed-${randomUUID()}@example.test`,
              name: "Changed",
            })
            .where(eq(users.id, DEV_ACTOR.id));
          expect(await initializeDevActorUser(transaction, true)).toBe(true);

          const restoredRows = await transaction
            .select()
            .from(users)
            .where(eq(users.id, DEV_ACTOR.id));
          expect(restoredRows).toHaveLength(1);
          expect(restoredRows[0]).toMatchObject({
            id: DEV_ACTOR.id,
            email: DEV_ACTOR.email,
            name: DEV_ACTOR.name ?? DEV_ACTOR.email,
          });

          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
  });

  test("fails loudly when another user owns the development email", async () => {
    const conflictingUserId = `dev-actor-conflict-${randomUUID()}`;

    await expect(
      runAsTenant(DEV_ACTOR.id, () =>
        database.transaction(async (transaction) => {
          await transaction.delete(users).where(eq(users.id, DEV_ACTOR.id));
          await transaction.insert(users).values({
            id: conflictingUserId,
            email: DEV_ACTOR.email,
            name: "Conflicting User",
          });

          await initializeDevActorUser(transaction, true);
        }),
      ),
    ).rejects.toThrow();

    expect(
      await runAsTenant(DEV_ACTOR.id, () =>
        database.select().from(users).where(eq(users.id, conflictingUserId)),
      ),
    ).toEqual([]);
  });

  test("the single-user actor gets one Free subscription row, however often it starts", async () => {
    const inaccessibleDatabase = {
      get select(): never {
        throw new Error("disabled provisioning accessed the database");
      },
      get insert(): never {
        throw new Error("disabled provisioning accessed the database");
      },
    } as unknown as Parameters<typeof provisionDevActorTenant>[0];
    expect(await provisionDevActorTenant(inaccessibleDatabase, false)).toBe(
      false,
    );

    const owned = () =>
      runAsTenant(DEV_ACTOR.id, async () => ({
        subscriptions: await database
          .select({ id: subscriptions.id, planId: subscriptions.planId })
          .from(subscriptions)
          .where(eq(subscriptions.tenantId, DEV_ACTOR.id)),
        avatar: await database
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, avatarAgentId(DEV_ACTOR.id))),
      }));
    // Other suites share the actor's tenant; only what this test created is removed afterwards.
    const before = await owned();
    await initializeDevActorUser(database, true);
    try {
      expect(await provisionDevActorTenant(database, true)).toBe(true);
      expect(await provisionDevActorTenant(database, true)).toBe(true);
      const after = await owned();
      expect(after.subscriptions).toHaveLength(
        Math.max(1, before.subscriptions.length),
      );
      if (before.subscriptions.length === 0)
        expect(after.subscriptions[0]?.planId).toBe("free");
      expect(after.avatar).toHaveLength(1);
      if (before.subscriptions.length === 0) {
        const plan = await createQuotaService(database).planFor(DEV_ACTOR.id);
        expect(plan.id).toBe("free");
        expect(plan.limits.customModels).toBeFalse();
      }
    } finally {
      await runAsTenant(DEV_ACTOR.id, async () => {
        if (before.avatar.length === 0) {
          await database
            .delete(agentProfiles)
            .where(eq(agentProfiles.agentId, avatarAgentId(DEV_ACTOR.id)));
          await database
            .delete(agents)
            .where(eq(agents.id, avatarAgentId(DEV_ACTOR.id)));
        }
        if (before.subscriptions.length === 0)
          await database
            .delete(subscriptions)
            .where(eq(subscriptions.tenantId, DEV_ACTOR.id));
      });
    }
  });
});
