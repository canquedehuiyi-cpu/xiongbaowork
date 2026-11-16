import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { HANDOFF_KIND } from "../src/agents/handoff";
import { readCoordinationHandoffClaim } from "../src/agents/handoff-tool";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const key = `remote-coordination-${randomUUID()}`;
const claim = { key, owner: "delivery-owner" };
const work = {
  fromBotId: "source-bot",
  toBotId: "remote-bot",
  actorId: "person-1",
  threadId: "source-thread",
  runId: "original-run",
  depth: 1,
  task: "Investigate the incident",
  initiator: { kind: "routine", id: "routine-1" },
};
const mine = and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, key));
/**
 * The hop is the person's row, offered in their tenant, and the callback that asks about it runs in
 * that same person's frame: the signed run names them.
 */
const asPerson = <T>(fn: () => T) => runAsTenant(work.actorId, fn);

beforeEach(async () => {
  await asPerson(async () => {
    await database.delete(workItems).where(mine);
    await database.insert(workItems).values({
      kind: HANDOFF_KIND,
      key,
      payload: work,
      claimedBy: claim.owner,
      leaseUntil: sql`now() + interval '1 minute'`,
    });
  });
});
afterAll(async () => {
  await asPerson(async () => {
    await database.delete(workItems).where(mine);
  });
  await database.$client.end({ timeout: 5 });
});

describe("remote coordination delivery ownership in PostgreSQL", () => {
  test("reads the source context only for the current active owner", async () => {
    expect(
      await asPerson(() => readCoordinationHandoffClaim(database, claim)),
    ).toEqual({
      work,
      owner: claim.owner,
      active: true,
    });
    expect(
      await asPerson(() =>
        readCoordinationHandoffClaim(database, {
          ...claim,
          owner: "another-owner",
        }),
      ),
    ).toBeNull();
  });

  test("an expired database-clock lease cannot authorize new coordination", async () => {
    await asPerson(() =>
      database
        .update(workItems)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(mine),
    );
    expect(
      await asPerson(() => readCoordinationHandoffClaim(database, claim)),
    ).toBeNull();
  });

  test("a finished delivery cannot authorize another callback", async () => {
    await asPerson(() =>
      database.update(workItems).set({ finishedAt: sql`now()` }).where(mine),
    );
    expect(
      await asPerson(() => readCoordinationHandoffClaim(database, claim)),
    ).toBeNull();
  });

  test("corrupt queued context fails visibly", async () => {
    await asPerson(() =>
      database.update(workItems).set({ payload: {} }).where(mine),
    );
    await expect(
      asPerson(() => readCoordinationHandoffClaim(database, claim)),
    ).rejects.toThrow("invalid work context");
  });
});
