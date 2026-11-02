import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import type {
  ComputerLocation,
  ComputerProvider,
} from "../src/computer/provider";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, workItems } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  CULL_KIND,
  offerIdleComputers,
  suspendClaimedComputers,
} from "../src/work/culler";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spinning a computer down when nobody is using it, which is the whole reason the fleet does not
 * cost a hundred idle browsers.
 *
 * The interesting cases are the ones where it must NOT act: a computer somebody just used, and a
 * computer nothing is known about. Suspending either takes a person's session away mid-task, and
 * both are easy to get wrong in a way no error ever reports.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createWorkQueue(database);
const suite = randomUUID().slice(0, 8);
const botOf = (name: string) => `cull-${suite}-${name}`;
/*
 * Two people, for the G01 cases. A computer is its Bot's, and the suspension runs as the tenant on
 * the Bot's own row, so every Bot this suite names is a real `agents` row owned by one of them.
 */
const tenantA = `cull-${suite}-tenant-a`;
const tenantB = `cull-${suite}-tenant-b`;
const ownedBots = [
  "idle",
  "busy",
  "returned",
  "unknown",
  "stopped",
  "a",
  "b",
  "c",
  "d",
  "recycled",
  "mine",
  "mislabelled",
  "unstamped",
].map(botOf);
// Bots stamped as nobody's (the shared catalogue): offered and suspended as the platform.
const nobodysBots = {
  system: botOf("system-bot"),
  platform: botOf("platform-bot"),
};

function providerWith(computers: ComputerLocation[]) {
  const stopped: string[] = [];
  const provider: ComputerProvider = {
    name: "fake",
    isolation: "per-bot",
    locate: async () => "http://unused",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async (botId) => {
      stopped.push(botId);
      return { wasRunning: true };
    },
    reset: async () => ({ cleared: false }),
    list: async () => computers,
  };
  return { provider, stopped };
}

const ran = (botId: string, when: Date) => ({
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: botId,
  payload: { bot: botId, action: "computer_navigate" },
  createdAt: when,
});

/*
 * The audit row a person's turn on the computer leaves behind, written in that person's frame the way
 * the gateway writes it. The culler reads it back as the platform, across tenants, so the person who
 * used a Bot need not be the Bot's owner: tenant A stands in for whoever it was.
 */
const used = (botId: string, when: Date) =>
  runAsTenant(tenantA, () =>
    database.insert(auditEvents).values(ran(botId, when)),
  );

/*
 * This suite's own rows and nobody else's.
 *
 * The kind is fixed by the culler, so scoping on it alone deleted every queued suspension in the
 * database. Against a shared development database that is somebody's real work, thrown away by a
 * test run. The keys are this suite's Bot ids, so that is what the sweep matches.
 */
const mine = () =>
  and(eq(workItems.kind, CULL_KIND), like(workItems.key, `cull-${suite}-%`));

beforeAll(async () => {
  await runAsTenant(tenantA, () =>
    database.insert(agents).values(
      ownedBots.map((id) => ({
        id,
        name: "Cull test Bot",
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
  await runAsTenant("platform", () =>
    database.insert(agents).values(
      Object.entries(nobodysBots).map(([tenantId, id]) => ({
        id,
        tenantId,
        name: "Cull test Bot of nobody's",
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
});

afterAll(async () => {
  // As the platform: the items are stamped with the Bots' tenants, and the Bots with theirs.
  await runAsTenant("platform", () => database.delete(workItems).where(mine()));
  await runAsTenant("platform", () =>
    database
      .delete(agents)
      .where(inArray(agents.id, [...ownedBots, ...Object.values(nobodysBots)])),
  );
  await database.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await runAsTenant("platform", () => database.delete(workItems).where(mine()));
});

const idleAfterMs = 30 * 60_000;
const now = () => new Date("2026-08-24T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(now().getTime() - minutes * 60_000);

describe("suspending computers nobody is using", () => {
  test("a computer idle longer than the threshold is offered, and then suspended", async () => {
    const botId = botOf("idle");
    await used(botId, minutesAgo(45));
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);
    const options = {
      database,
      queue,
      provider,
      idleAfterMs,
      owner: "replica-1",
      now,
    };

    expect((await offerIdleComputers(options)).offered).toEqual([botId]);
    const report = await suspendClaimedComputers(options);

    expect(report.suspended).toEqual([botId]);
    expect(stopped).toEqual([botId]);
  });

  test("a computer used a minute ago is left alone", async () => {
    const botId = botOf("busy");
    await used(botId, minutesAgo(1));
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);

    const offered = await offerIdleComputers({
      database,
      queue,
      provider,
      idleAfterMs,
      owner: "replica-1",
      now,
    });

    expect(offered.offered).toEqual([]);
    expect(stopped).toEqual([]);
  });

  /*
   * The race the lease exists for. One replica decides a computer is idle; before anything acts on
   * that, the person comes back. Suspending them mid-task is worse than paying for another five
   * minutes of an idle browser, so the decision is re-checked at the moment of acting.
   */
  test("a computer used after being offered is not suspended", async () => {
    const botId = botOf("returned");
    await used(botId, minutesAgo(45));
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);
    const options = {
      database,
      queue,
      provider,
      idleAfterMs,
      owner: "replica-1",
      now,
    };

    await offerIdleComputers(options);
    // They came back while the item sat on the queue.
    await used(botId, minutesAgo(2));
    const report = await suspendClaimedComputers(options);

    expect(stopped).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("used again");
  });

  test("a computer nothing is known about is left alone", async () => {
    // No audit row and no start time. Suspending on no evidence is how a session disappears.
    const botId = botOf("unknown");
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);

    const offered = await offerIdleComputers({
      database,
      queue,
      provider,
      idleAfterMs,
      owner: "replica-1",
      now,
    });

    expect(offered.offered).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a computer already stopped is not offered again", async () => {
    const botId = botOf("stopped");
    await used(botId, minutesAgo(90));
    const { provider } = providerWith([
      { botId, status: "stopped", url: "http://c" },
    ]);

    expect(
      (
        await offerIdleComputers({
          database,
          queue,
          provider,
          idleAfterMs,
          owner: "replica-1",
          now,
        })
      ).offered,
    ).toEqual([]);
  });

  test("two replicas culling together suspend each computer once", async () => {
    const ids = ["a", "b", "c", "d"].map(botOf);
    for (const botId of ids) {
      await used(botId, minutesAgo(60));
    }
    const { provider, stopped } = providerWith(
      ids.map((botId) => ({
        botId,
        status: "running" as const,
        url: "http://c",
      })),
    );
    const base = { database, queue, provider, idleAfterMs, now };

    await offerIdleComputers({ ...base, owner: "replica-1" });
    const [first, second] = await Promise.all([
      suspendClaimedComputers({ ...base, owner: "replica-1" }),
      suspendClaimedComputers({ ...base, owner: "replica-2" }),
    ]);

    const all = [...first.suspended, ...second.suspended];
    expect(all.sort()).toEqual([...ids].sort());
    // Each exactly once, which is the point of claiming rather than sweeping.
    expect(new Set(stopped).size).toBe(stopped.length);
  });

  /*
   * The second idle window, which is the one that pays for scale-to-zero.
   *
   * A computer is suspended once and then resumed, used, and left alone again. Every sweep after the
   * first was offering work that the finished row silently swallowed, so the Bot stayed awake until
   * that row aged out a day later. The queue is right to keep the row: it is what stops the same key
   * running twice. It is the retention window for a finished suspension that has to be the idle
   * window rather than a day, which is what the sweep below passes.
   */
  test("a computer used again after it was suspended is suspended again", async () => {
    const botId = botOf("recycled");
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);
    const at = (iso: string) => () => new Date(iso);
    const sweep = async (whenIso: string) => {
      const options = {
        database,
        queue,
        provider,
        idleAfterMs,
        owner: "replica-1",
        now: at(whenIso),
      };
      await offerIdleComputers(options);
      const report = await suspendClaimedComputers(options);
      /*
       * What the CronJob does at the end of every sweep. Zero here rather than the idle window
       * because these rows are finished seconds ago in real time and `purge` reads the database's
       * clock, not this test's: the window being separate from the give-up one is the property
       * under test, not its length.
       */
      await queue.purge({
        kind: CULL_KIND,
        olderThanMs: 24 * 60 * 60_000,
        finishedOlderThanMs: 0,
      });
      return report;
    };

    await used(botId, minutesAgo(60));
    expect((await sweep("2026-08-24T12:00:00Z")).suspended).toEqual([botId]);

    // Somebody comes back at 13:00, and it is quiet again by 14:00.
    await used(botId, new Date("2026-08-24T13:00:00Z"));
    const second = await sweep("2026-08-24T14:00:00Z");

    expect(second.suspended).toEqual([botId]);
    expect(stopped).toEqual([botId, botId]);
  });
});

describe("whose suspension it is (G01)", () => {
  const options = (provider: ComputerProvider) => ({
    database,
    queue,
    provider,
    idleAfterMs,
    owner: "replica-1",
    now,
  });
  const stampOf = (botId: string, tenant: string) =>
    runAsTenant(tenant, () =>
      database
        .select({ tenantId: workItems.tenantId })
        .from(workItems)
        .where(and(eq(workItems.kind, CULL_KIND), eq(workItems.key, botId))),
    );

  test("is offered in the Bot's own tenant, which another tenant cannot read", async () => {
    const botId = botOf("mine");
    await used(botId, minutesAgo(45));
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);

    expect((await offerIdleComputers(options(provider))).offered).toEqual([
      botId,
    ]);
    expect(await stampOf(botId, "platform")).toEqual([{ tenantId: tenantA }]);
    expect(await stampOf(botId, tenantB)).toEqual([]);

    expect(
      (await suspendClaimedComputers(options(provider))).suspended,
    ).toEqual([botId]);
    expect(stopped).toEqual([botId]);
  });

  test("a Bot stamped as nobody's is offered and suspended as the platform", async () => {
    const ids = [nobodysBots.system, nobodysBots.platform];
    for (const botId of ids) await used(botId, minutesAgo(90));
    const { provider, stopped } = providerWith(
      ids.map((botId) => ({
        botId,
        status: "running" as const,
        url: "http://c",
      })),
    );

    const { offered, offeredAsPlatform } = await offerIdleComputers(
      options(provider),
    );
    expect([...offered].sort()).toEqual([...ids].sort());
    expect([...offeredAsPlatform].sort()).toEqual([...ids].sort());
    // Stamped as the platform, so no person's frame can see the item.
    for (const botId of ids) {
      expect(await stampOf(botId, "platform")).toEqual([
        { tenantId: "platform" },
      ]);
      expect(await stampOf(botId, tenantA)).toEqual([]);
    }

    expect(
      [...(await suspendClaimedComputers(options(provider))).suspended].sort(),
    ).toEqual([...ids].sort());
    expect([...stopped].sort()).toEqual([...ids].sort());
  });

  test("an orphaned computer, whose Bot row is gone, is still suspended as the platform", async () => {
    const botId = botOf("orphan");
    await used(botId, minutesAgo(90));
    const { provider, stopped } = providerWith([
      { botId, status: "running", url: "http://c" },
    ]);

    expect(await offerIdleComputers(options(provider))).toEqual({
      offered: [botId],
      offeredAsPlatform: [botId],
    });
    expect(await stampOf(botId, "platform")).toEqual([
      { tenantId: "platform" },
    ]);
    expect(
      (await suspendClaimedComputers(options(provider))).suspended,
    ).toEqual([botId]);
    expect(stopped).toEqual([botId]);
  });

  test("an item stamped as nobody's, or as another tenant than its Bot's, is ended without suspending", async () => {
    const mislabelled = botOf("mislabelled");
    const unstamped = botOf("unstamped");
    for (const botId of [mislabelled, unstamped])
      await used(botId, minutesAgo(90));
    const { provider, stopped } = providerWith([]);
    const offer = (botId: string) =>
      queue.offer({
        kind: CULL_KIND,
        key: botId,
        payload: { botId, idleSince: minutesAgo(90).toISOString() },
      });
    // Someone else's frame names tenant A's Bot; the platform's frame names nobody.
    await runAsTenant(tenantB, () => offer(mislabelled));
    await runAsTenant("platform", () => offer(unstamped));

    const report = await suspendClaimedComputers(options(provider));

    expect(stopped).toEqual([]);
    expect(report.suspended).toEqual([]);
    expect(
      report.skipped
        .filter((skip) => [mislabelled, unstamped].includes(skip.botId))
        .map((skip) => skip.reason.startsWith("tenant unresolved"))
        .sort(),
    ).toEqual([true, true]);
    // Ended, not released: a later pass does not pick them up again.
    expect((await suspendClaimedComputers(options(provider))).considered).toBe(
      0,
    );
  });
});
