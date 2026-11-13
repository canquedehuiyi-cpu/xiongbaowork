import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users, wakerGroups } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { stateOf } from "../src/waker-groups/channel-link";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The upgrade that turns crews into chats and gives old chats a crew (spec 2026-11-13 group-unify,
 * section 5; migrations 0210, 0211).
 *
 * Its ledger, `waker_group_upgrades`, is one row per crew the upgrade touched: what it did, the chat
 * it made or linked, the coworkers it left out. It is the owner's row like any tenant row (0072's
 * four policies, FORCE), it goes with the crew when the crew is deleted, and it follows the crew to
 * the heir when a shared group is handed over, while `original_owner` keeps who it was written for
 * (the rollback runbook leaves alone a converted crew that has changed hands). The app may never
 * change `original_owner` once written (0211).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wgup-${randomUUID()}`;
const createdUsers: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    const channelIds = createdChannels.splice(0);
    if (channelIds.length)
      await database.execute(
        sql`delete from channels where id in ${channelIds}`,
      );
    const userIds = createdUsers.splice(0);
    if (userIds.length) {
      // The ledger rows go with their crews.
      await database
        .delete(wakerGroups)
        .where(inArray(wakerGroups.tenantId, userIds));
      await database.delete(users).where(inArray(users.id, userIds));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string) {
  const id = `${prefix}-${name}-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Upgrade" }),
  );
  createdUsers.push(id);
  return id;
}

async function crew(owner: string, name: string) {
  const [row] = await runAsTenant(owner, () =>
    database
      .insert(wakerGroups)
      .values({ name })
      .returning({ id: wakerGroups.id }),
  );
  if (!row) throw new Error("crew not written");
  return row.id;
}

/** A ledger row written in `frame`, stamped for `tenant`. */
function record(
  frame: string,
  groupId: string,
  tenant: string,
  outcome = "converted",
) {
  return runAsTenant(frame, () =>
    database.execute(
      sql`insert into waker_group_upgrades (group_id, tenant_id, original_owner, outcome)
          values (${groupId}::uuid, ${tenant}, ${tenant}, ${outcome})`,
    ),
  );
}

/** The ledger rows of `groupIds` that `frame` can see. */
async function ledger(frame: string, groupIds: string[]) {
  return (await runAsTenant(frame, () =>
    database.execute(
      sql`select group_id::text as group_id, tenant_id, original_owner
            from waker_group_upgrades where group_id::text in ${groupIds}
           order by tenant_id`,
    ),
  )) as unknown as {
    group_id: string;
    tenant_id: string;
    original_owner: string;
  }[];
}

/** The SQLSTATE a write threw. */
async function refusal(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return stateOf(error);
  }
  throw new Error("expected a refusal");
}

/** What the database said, under drizzle's "Failed query" wrapper. */
function reason(error: unknown) {
  return String((error as { cause?: Error }).cause?.message ?? error);
}

describe("ledger", () => {
  test("the journal registers 0210 after 0209", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const previous = journal.entries.find((item) => item.idx === 209);
    const entry = journal.entries.find((item) => item.idx === 210);
    expect(previous?.tag).toBe("0209_channel_kind");
    expect(entry?.tag).toBe("0210_waker_group_upgrades");
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? Infinity);
  });

  test("a tenant reads and writes only its own ledger rows; platform reads all", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    const another = await crew(alice, "复盘");
    const theirs = await crew(bob, "周报");

    await record(alice, ours, alice);
    expect(await refusal(() => record(alice, another, bob))).toBe("42501");
    await record(bob, theirs, bob);

    const all = [ours, another, theirs];
    expect((await ledger(alice, all)).map((row) => row.group_id)).toEqual([
      ours,
    ]);
    expect((await ledger(bob, all)).map((row) => row.group_id)).toEqual([
      theirs,
    ]);
    expect(
      (await ledger("platform", all)).map((row) => row.group_id).sort(),
    ).toEqual([ours, theirs].sort());

    // Bob can neither change nor delete Alice's row: to him it is not there.
    await runAsTenant(bob, async () => {
      await database.execute(
        sql`update waker_group_upgrades set outcome = 'no_owner' where group_id = ${ours}::uuid`,
      );
      await database.execute(
        sql`delete from waker_group_upgrades where group_id = ${ours}::uuid`,
      );
    });
    const [kept] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select outcome from waker_group_upgrades where group_id = ${ours}::uuid`,
      ),
    )) as unknown as { outcome: string }[];
    expect(kept?.outcome).toBe("converted");
  });

  test("the journal registers 0211 after 0210", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const previous = journal.entries.find((item) => item.idx === 210);
    const entry = journal.entries.find((item) => item.idx === 211);
    expect(entry?.tag).toBe("0211_waker_group_upgrades_original_owner");
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? Infinity);
  });

  test("a tenant cannot hand its own ledger row to another tenant", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    // WITH CHECK, the half of the update policy the cross-tenant test above does not reach.
    const refused = await runAsTenant(alice, () =>
      database.execute(
        sql`update waker_group_upgrades set tenant_id = ${bob} where group_id = ${ours}::uuid`,
      ),
    ).catch((error: unknown) => error);
    expect(stateOf(refused)).toBe("42501");
    expect(reason(refused)).toContain("row-level security");
    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: alice, original_owner: alice },
    ]);
  });

  test("every outcome the upgrade writes is accepted", async () => {
    const alice = await person("alice");
    const outcomes = [
      "started",
      "converted",
      "backfilled",
      "pending_members",
      "too_many",
      "no_owner",
    ];
    const ids: string[] = [];
    for (const outcome of outcomes) {
      const id = await crew(alice, `台账 ${outcome}`);
      await record(alice, id, alice, outcome);
      ids.push(id);
    }

    const rows = (await runAsTenant(alice, () =>
      database.execute(
        sql`select outcome from waker_group_upgrades where group_id::text in ${ids}`,
      ),
    )) as unknown as { outcome: string }[];
    expect(rows.map((row) => row.outcome).sort()).toEqual([...outcomes].sort());
  });

  test("original_owner keeps the value it was first written with", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    // Not even the platform frame may change it: the app has no UPDATE on the column (0211).
    for (const frame of [alice, "platform"]) {
      const refused = await runAsTenant(frame, () =>
        database.execute(
          sql`update waker_group_upgrades set original_owner = ${bob} where group_id = ${ours}::uuid`,
        ),
      ).catch((error: unknown) => error);
      expect(stateOf(refused)).toBe("42501");
      expect(reason(refused)).toContain("permission denied");
    }
    // Every other column the upgrade moves stays writable.
    await runAsTenant("platform", () =>
      database.execute(
        sql`update waker_group_upgrades
               set outcome = 'started', channel_id = 'c', dropped_agent_ids = '{a}',
                   started_at = now(), updated_at = now(), tenant_id = ${bob}
             where group_id = ${ours}::uuid`,
      ),
    );
    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: bob, original_owner: alice },
    ]);
  });

  test("an unknown outcome is refused", async () => {
    const alice = await person("alice");
    const ours = await crew(alice, "周报");

    expect(await refusal(() => record(alice, ours, alice, "done"))).toBe(
      "23514",
    );
  });

  test("deleting the crew deletes its ledger row", async () => {
    const alice = await person("alice");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    await runAsTenant(alice, () =>
      database.execute(sql`delete from waker_groups where id = ${ours}::uuid`),
    );

    expect(await ledger("platform", [ours])).toEqual([]);
  });

  test("a hand-over moves the crew's ledger row too", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const ours = await crew(alice, "周报");
    const untouched = await crew(alice, "复盘");
    await record(alice, ours, alice);
    await record(alice, untouched, alice);
    // A shared group Alice started and has left past the service; Bob is still in it.
    const channelId = `channel_${randomUUID()}`;
    createdChannels.push(channelId);
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`insert into channels (id, name, description, tenant_id, created_by, title, waker_group_id)
            values (${channelId}, '员工甲、员工乙', '', 'team', ${alice}, '周报', ${ours}::uuid)`,
      );
      await database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id)
            values (${channelId}, ${bob}, 'team'), (${channelId}, ${carol}, 'team')`,
      );
    });

    const [handed] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
      ),
    )) as unknown as { owner: string | null }[];
    expect(handed?.owner).toBe(bob);

    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: bob, original_owner: alice },
    ]);
    expect(await ledger(bob, [ours])).toHaveLength(1);
    expect(await ledger(alice, [ours])).toEqual([]);
    // Only the crew that went: Alice's other row stays hers.
    expect(await ledger("platform", [untouched])).toEqual([
      { group_id: untouched, tenant_id: alice, original_owner: alice },
    ]);
  });
});
