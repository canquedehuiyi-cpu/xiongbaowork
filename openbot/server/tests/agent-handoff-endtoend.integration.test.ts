import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createHandoffDesk } from "../src/agents/handoff";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import { HANDOFF_TOOL, handoffTool } from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import {
  createWakeUpRunner,
  createWakeUpStore,
  WAKE_UP_KIND,
  wakeUpTools,
} from "../src/agents/wake-up";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { SYSTEM_TENANT, TEAM_TENANT } from "../src/db/schema/tenant";
import {
  asPlatform,
  currentTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { expectUnframedRefused } from "./support/frame-guard";

/**
 * A hop from end to end: a Bot calls the tool, and another replica delivers it.
 *
 * THE TWO HALVES NEVER SPEAK. Deciding happens in one run and delivering in another process, and the
 * only thing between them is a row. That is the property worth an integration test: unit tests on
 * either side pass while the row they agree on is written by one and unreadable by the other.
 *
 * The delivery is faked and nothing else is. Running a real model against a real thread is not what
 * this is asking about, and it would make the test slow, expensive and non-deterministic for a
 * question the two files either side already answer.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const ASKER = `e2e-asker-${suite}`;
const TARGET = `e2e-target-${suite}`;
const ACTOR = `e2e-actor-${suite}`;
/** Somebody else entirely: a second tenant, to ask whether the first one's rows leak to it. */
const STRANGER = `e2e-stranger-${suite}`;
const RUN = `e2e-run-${suite}`;

const queue = createWorkQueue(database);
const auditStore = createAuditStore(database);
const profiles = createAgentProfileStore(database);

const desk = createHandoffDesk({
  queue,
  profiles,
  // The person's own role, as the request path resolves it: an administrator sees Bots a user does
  // not, and a hop to one of those is theirs to make.
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, fromBotId),
          ),
        )
    ).some((row) => row.ref === toBotId),
  auditStore,
  caps: { maxDepth: 2, maxPerRun: 3 },
});

/** Follow-ups this file made, by key, so the tear-down can find them in whichever tenant they landed. */
const wakeUpKeys: string[] = [];

async function clean() {
  // As `platform`: a hop is offered in its person's tenant, and a tear-down from no frame would see
  // only `system` rows and leave every one of the person's behind.
  await runAsTenant("platform", async () => {
    // By the suite's own actor, which every hop's payload carries. A hop's key is `hop:<hash>:<hash>`,
    // so a key prefix matches nothing, and a hop left queued is claimed by the next suite's sweep.
    await database
      .delete(workItems)
      .where(sql`${workItems.payload}->>'actorId' = ${ACTOR}`);
    if (wakeUpKeys.length > 0)
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            inArray(workItems.key, wakeUpKeys),
          ),
        );
    for (const id of [ASKER, TARGET]) {
      await database.delete(pluginGrants).where(eq(pluginGrants.agentId, id));
      await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
      await database.delete(agents).where(eq(agents.id, id));
    }
  });
}

beforeEach(async () => {
  await clean();
  // Built-in Bots are the deployment's catalogue (`system`), which every person's run must read.
  await runAsTenant("system", async () => {
    for (const [id, name] of [
      [ASKER, "Asker"],
      [TARGET, "Target"],
    ]) {
      await database
        .insert(agents)
        .values({ id, name, type: "built_in", configuration: {} })
        .onConflictDoNothing();
      await database
        .insert(agentProfiles)
        .values({
          agentId: id,
          name,
          title: "",
          roleDescription: "",
          avatarSeed: id,
          visibility: "public",
        })
        .onConflictDoNothing();
    }
  });
  // The grant is configuration made in the person's own tenant, where every hop here is asked.
  await runAsTenant(ACTOR, async () => {
    await database
      .insert(pluginGrants)
      .values({ kind: "bot", ref: TARGET, agentId: ASKER, grantedBy: "test" })
      .onConflictDoNothing();
  });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("a hop, from the tool call to the delivery", () => {
  test("what one Bot asked for is what the other is shown", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });

    // The asking Bot's own words, through the tool it is offered.
    // Inside the person's own tenant, which is where a Bot's run always is.
    const said = await runAsTenant(ACTOR, () =>
      tool?.execute({
        bot: "Target",
        task: "find the outage window",
        constraints: "yesterday only",
        expecting: "a date range",
      }),
    );
    expect(said).toContain("Target");

    // A different process entirely, sharing nothing but the row.
    const delivered: Array<{ work: HandoffWork; message: string }> = [];
    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: {
        deliver: async ({ work, message }) => {
          delivered.push({ work, message });
          return { answer: null };
        },
      },
    });

    const report = await runner.sweep();

    expect(report.delivered).toContain(TARGET);
    const seen = delivered.find((entry) => entry.work.toBotId === TARGET);
    expect(seen?.work).toMatchObject({
      fromBotId: ASKER,
      actorId: ACTOR,
      threadId: `thread-${suite}`,
      depth: 1,
    });
    // Every part the asking model was made to name survives to the other side.
    expect(seen?.message).toContain("find the outage window");
    expect(seen?.message).toContain("yesterday only");
    expect(seen?.message).toContain("a date range");
    // Attributed by the deployment, from the row rather than from anything a model wrote.
    expect(seen?.message).toContain(ASKER);
  });

  test("a delivered hop is finished, so a second sweep does not run the Bot again", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });
    await runAsTenant(ACTOR, () =>
      tool?.execute({ bot: "Target", task: "have a look" }),
    );

    const sweepWith = (owner: string) => {
      const seen: string[] = [];
      return {
        seen,
        runner: createHandoffRunner({
          queue: createWorkQueue(database),
          owner,
          sign: () => "signed",
          auditStore,
          delivery: {
            deliver: async ({ work }) => {
              seen.push(work.toBotId);
              return { answer: null };
            },
          },
        }),
      };
    };

    const first = sweepWith(`replica-a-${suite}`);
    await first.runner.sweep();
    const second = sweepWith(`replica-b-${suite}`);
    await second.runner.sweep();

    expect(first.seen).toEqual([TARGET]);
    // The row is finished rather than deleted, so re-offering the same hop collides too.
    expect(second.seen).toEqual([]);
  });

  test("the whole path leaves a trail somebody can follow", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });
    await runAsTenant(ACTOR, () =>
      tool?.execute({ bot: "Target", task: "have a look" }),
    );

    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: { deliver: async () => ({ answer: null }) },
    });
    await runner.sweep();

    // Read as the person: the trail is theirs, and that is who will read it.
    const rows = await runAsTenant(ACTOR, () =>
      database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, TARGET)),
    );
    const kinds = rows.map((row) => row.eventType);
    expect(kinds).toContain("agent.handoff_offered");
    expect(kinds).toContain("agent.handoff_delivered");
    expect(
      rows.every((row) => (row.payload as { run?: string }).run === RUN),
    ).toBe(true);
  });
});

/**
 * G01: background work runs as the tenant on the row it acts on.
 *
 * The sweep is a timer and has no tenant of its own. Before this, a hop or a follow-up ran its whole
 * chain as `system`: the trail, the follow-on hops and the settled outcome were stamped as the
 * platform's, which every tenant can read. The trusted answer to "whose work is this" is the tenant
 * stamped on the claimed row, so that is the frame it now runs in, and a row stamped as nobody's is
 * ended without running anybody.
 *
 * In this file rather than one of its own, to keep the change inside one package: the property is
 * the one this file already asks about — what crosses between the two halves is a row — and it is
 * asked of both kinds of background work that cross that way.
 */
describe("G01: whose work a sweep is doing", () => {
  test("a hop's trail and its relay land in the person's tenant, and nobody else's", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });
    await runAsTenant(ACTOR, () =>
      tool?.execute({ bot: "Target", task: "when was the outage" }),
    );

    const seenAs: string[] = [];
    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: {
        deliver: async ({ work }) => {
          if (work.actorId === ACTOR) seenAs.push(currentTenant());
          return { answer: "Tuesday, 02:10 to 02:45." };
        },
      },
    });
    // As the real loop's claim asks: for nobody in particular.
    const report = await runAsTenant("platform", () => runner.sweep());
    expect(report.delivered).toContain(TARGET);
    expect(seenAs).toEqual([ACTOR]);

    const mine = sql`${workItems.payload}->>'actorId' = ${ACTOR}`;
    const ofRun = sql`${auditEvents.payload}->>'run' = ${RUN}`;
    const everywhere = await runAsTenant("platform", async () => ({
      work: await database
        .select({ key: workItems.key, tenantId: workItems.tenantId })
        .from(workItems)
        .where(mine),
      trail: await database
        .select({
          eventType: auditEvents.eventType,
          tenantId: auditEvents.tenantId,
        })
        .from(auditEvents)
        .where(ofRun),
    }));
    // The hop, and the relay it queued on the way home, are both the person's.
    expect(everywhere.work.some((row) => row.key.startsWith("relay:"))).toBe(
      true,
    );
    expect(new Set(everywhere.work.map((row) => row.tenantId))).toEqual(
      new Set([ACTOR]),
    );
    expect(everywhere.trail.map((row) => row.eventType)).toContain(
      "agent.handoff_delivered",
    );
    expect(new Set(everywhere.trail.map((row) => row.tenantId))).toEqual(
      new Set([ACTOR]),
    );

    // And a stranger sees none of it.
    const strangerSees = await runAsTenant(STRANGER, async () => ({
      work: await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(mine),
      trail: await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(ofRun),
    }));
    expect(strangerSees).toEqual({ work: [], trail: [] });
  });

  /*
   * Two stamps that name nobody. `system` is what an offer from no frame used to get by default, so
   * it is offered here from an explicit `system` frame; `team` is a stamp no frame can write, so that
   * row is put on the queue the only way one can be, by `platform`. Neither has a person to act as.
   *
   * THE THIRD CASE IS THE ONE THAT ASKS `isPersonTenant` ABOUT `team`. A `team` stamp on a hop for
   * a real person is refused by the owner/stamp comparison as well, so it would still be refused if
   * `team` were ever taken for a person. A hop whose payload names `team` as its person agrees with
   * its own stamp: the only thing left to refuse it is that `team` is nobody.
   */
  test.each([
    [SYSTEM_TENANT, ACTOR],
    [TEAM_TENANT, ACTOR],
    [TEAM_TENANT, TEAM_TENANT],
  ])(
    "a hop stamped as nobody's (`%s`, for `%s`) is ended without running anybody",
    async (stamp, actorId) => {
      const run = `${RUN}-nobody-${stamp}-for-${actorId}`;
      const key = `${run}:${TARGET}`;
      const payload = {
        fromBotId: ASKER,
        toBotId: TARGET,
        actorId,
        threadId: `thread-${suite}`,
        runId: run,
        depth: 1,
        task: "nobody's question",
      };
      if (stamp === SYSTEM_TENANT)
        expect(
          await runAsTenant(SYSTEM_TENANT, () =>
            createWorkQueue(database).offer({
              kind: "bot.message",
              key,
              payload,
            }),
          ),
        ).toBe("queued");
      else
        await asPlatform(() =>
          database
            .insert(workItems)
            .values({ kind: "bot.message", key, payload, tenantId: stamp }),
        );
      const [stamped] = await asPlatform(() =>
        database
          .select({ tenantId: workItems.tenantId })
          .from(workItems)
          .where(
            and(eq(workItems.kind, "bot.message"), eq(workItems.key, key)),
          ),
      );
      expect(stamped?.tenantId).toBe(stamp);

      const ran: string[] = [];
      const runner = createHandoffRunner({
        queue: createWorkQueue(database),
        owner: `replica-${suite}`,
        sign: () => "signed",
        auditStore,
        delivery: {
          deliver: async ({ work }) => {
            ran.push(work.runId);
            return { answer: "should never be relayed" };
          },
        },
      });
      const report = await runAsTenant("platform", () => runner.sweep());

      expect(ran).not.toContain(run);
      expect(report.skipped).toContainEqual({
        key,
        reason: "tenant_unresolved",
      });
      const after = await runAsTenant("platform", async () => ({
        row: await database
          .select({ finishedAt: workItems.finishedAt })
          .from(workItems)
          .where(
            and(eq(workItems.kind, "bot.message"), eq(workItems.key, key)),
          ),
        trail: await database
          .select({
            eventType: auditEvents.eventType,
            tenantId: auditEvents.tenantId,
            actorUserId: auditEvents.actorUserId,
          })
          .from(auditEvents)
          .where(sql`${auditEvents.payload}->>'run' = ${run}`),
        relays: await database
          .select({ key: workItems.key })
          .from(workItems)
          .where(
            sql`${workItems.key} like ${`%${key}`} and ${workItems.key} <> ${key}`,
          ),
      }));
      expect(after.row[0]?.finishedAt).not.toBeNull();
      // One row says it was dropped: the platform's, naming nobody, so no tenant can read it.
      expect(after.trail).toEqual([
        {
          eventType: "agent.handoff_failed",
          tenantId: "platform",
          actorUserId: null,
        },
      ]);
      expect(after.relays).toEqual([]);
    },
  );

  /** A follow-up runner over the real queue and store, with only the turn and the channel faked. */
  function wakeUps() {
    const turns: Array<{ owner: string; tenant: string }> = [];
    const wakeUpQueue = createWorkQueue(database);
    const store = createWakeUpStore(database);
    const runner = createWakeUpRunner({
      queue: wakeUpQueue,
      store,
      owner: `wake-${suite}`,
      actorFor: async (id) => ({ id, role: "user" }),
      channels: {
        get: async () => null,
        direct: async () => ({
          id: `channel-${suite}`,
          threadId: `thread-${suite}`,
          name: "",
          agentIds: [],
          active: true,
          lastMessageAt: null,
        }),
        recordActivity: async () => {},
      },
      runTurn: async ({ ownerUserId }) => {
        turns.push({ owner: ownerUserId, tenant: currentTenant() });
        return { replyText: "Checked." };
      },
    });
    /**
     * Sweep until this key has been handled. One claim per sweep and oldest first, so a follow-up
     * another file left due may be taken before ours.
     */
    const sweepUntil = async (key: string) => {
      for (let i = 0; i < 25; i += 1) {
        const report = await runAsTenant("platform", () => runner.sweep());
        if (report.ran.includes(key)) return "ran";
        if (report.skipped.includes(key)) return "skipped";
        if (report.ran.length === 0 && report.skipped.length === 0) break;
      }
      return "untouched";
    };
    return { store, turns, sweepUntil };
  }

  /**
   * A follow-up row written straight to the queue, stamped by whichever frame writes it, or with
   * `stamp` when one is named: a stamp no frame writes by default, so the caller is `platform`.
   */
  async function dueFollowUp(ownerUserId: string, stamp?: string) {
    const key = `wake:${suite}:${randomUUID()}`;
    wakeUpKeys.push(key);
    await database.insert(workItems).values({
      kind: WAKE_UP_KIND,
      key,
      runAt: new Date(Date.now() - 60_000),
      payload: {
        ownerUserId,
        agentId: TARGET,
        reason: "check the build",
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledAt: new Date(Date.now() - 120_000).toISOString(),
      },
      ...(stamp === undefined ? {} : { tenantId: stamp }),
    });
    return key;
  }

  const outcomeOf = (key: string) =>
    database
      .select({ tenantId: workItems.tenantId, payload: workItems.payload })
      .from(workItems)
      .where(and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, key)));

  test("a follow-up runs, and settles, as the person who scheduled it", async () => {
    const { store, turns, sweepUntil } = wakeUps();
    const scheduled = await runAsTenant(ACTOR, () =>
      store.schedule({
        ownerUserId: ACTOR,
        agentId: TARGET,
        reason: "check the build",
        dueAt: new Date(Date.now() + 2 * 60_000),
      }),
    );
    wakeUpKeys.push(scheduled.id);
    // Made due in the person's own frame, because it is their row.
    await runAsTenant(ACTOR, () =>
      database
        .update(workItems)
        .set({ runAt: new Date(Date.now() - 60_000) })
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            eq(workItems.key, scheduled.id),
          ),
        ),
    );

    expect(await sweepUntil(scheduled.id)).toBe("ran");
    expect(turns.filter((turn) => turn.owner === ACTOR)).toEqual([
      { owner: ACTOR, tenant: ACTOR },
    ]);
    const [row] = await runAsTenant(ACTOR, () => outcomeOf(scheduled.id));
    expect(row?.tenantId).toBe(ACTOR);
    // Settling merges into the payload object; a double-encoded outcome would turn it into an array.
    expect(Array.isArray(row?.payload)).toBe(false);
    expect(
      (row?.payload as { outcome?: { status: string } } | undefined)?.outcome
        ?.status,
    ).toBe("succeeded");
    expect(await runAsTenant(STRANGER, () => outcomeOf(scheduled.id))).toEqual(
      [],
    );
  });

  /*
   * `system` is the stamp a background row used to get by default from no frame, so it is written
   * here from an explicit `system` frame. `team` is a stamp no frame can write, so that row is
   * written by `platform`. Both name nobody, so neither has a person whose turn could run.
   *
   * As with the hop above, the last case is the one that reaches `isPersonTenant("team")`: a payload
   * that names `team` as its owner agrees with its `team` stamp, so the owner/stamp comparison has
   * nothing to refuse and only "`team` is nobody" stands between it and a turn.
   */
  test.each([
    [SYSTEM_TENANT, ACTOR],
    [TEAM_TENANT, ACTOR],
    [TEAM_TENANT, TEAM_TENANT],
  ])(
    "a follow-up stamped `%s` (for `%s`) is failed and its turn never runs",
    async (stamp, ownerUserId) => {
      const { turns, sweepUntil } = wakeUps();
      const key =
        stamp === SYSTEM_TENANT
          ? await runAsTenant(SYSTEM_TENANT, () => dueFollowUp(ownerUserId))
          : await asPlatform(() => dueFollowUp(ownerUserId, stamp));

      expect(await sweepUntil(key)).toBe("skipped");
      expect(turns.filter((turn) => turn.owner === ownerUserId)).toEqual([]);
      const [row] = await runAsTenant("platform", () => outcomeOf(key));
      expect(row?.tenantId).toBe(stamp);
      expect(
        (row?.payload as { outcome?: { status: string } } | undefined)?.outcome
          ?.status,
      ).toBe("failed");
    },
  );

  test("a follow-up whose owner is not the tenant on its row is refused", async () => {
    const { turns, sweepUntil } = wakeUps();
    // Stamped as one person, claiming to be for another.
    const key = await runAsTenant(ACTOR, () => dueFollowUp(STRANGER));

    expect(await sweepUntil(key)).toBe("skipped");
    expect(turns.filter((turn) => turn.owner === STRANGER)).toEqual([]);
    const [row] = await runAsTenant("platform", () => outcomeOf(key));
    expect(row?.tenantId).toBe(ACTOR);
    expect(
      (row?.payload as { outcome?: { status: string } } | undefined)?.outcome
        ?.status,
    ).toBe("failed");
  });

  /*
   * The callback a framework Bot runs its tools through has a shared secret, not a session, so no
   * guard framed it, and what it queued was stamped `system`. With the sweeps now refusing `system`
   * work, an unframed route would turn every follow-up and hop a framework Bot asks for into a drop.
   * The caller below is the shape of the deployment's own (index.ts) cut to the two tools that
   * queue work; the route, the signature check, the desk, the store, the queue and both sweeps are
   * the real ones.
   */
  test("a follow-up and a hop asked for through the agent callback are the person's, and run", async () => {
    const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const TOKEN = `legacy-${suite}`;
    const run = `${RUN}-callback`;
    const { store, turns, sweepUntil } = wakeUps();
    const calledAs: string[] = [];
    const app = createApp(
      loadConfig(
        testEnvironment({ AGENT_TOOL_TOKEN: TOKEN, KEY_ENCRYPTION_KEY: KEY }),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (input) => {
        calledAs.push(currentTenant());
        if (input.name === HANDOFF_TOOL) {
          const hop = handoffTool({
            desk,
            from: input.run,
            hasSomebodyToAsk: true,
            maxDepth: 2,
            maxPerRun: 3,
          });
          const text = String(await hop?.execute(input.args));
          return { text, isError: text.startsWith("Refused.") };
        }
        const followUp = wakeUpTools({
          store,
          ownerUserId: input.actorId,
          agentId: input.botId,
        }).find((candidate) => candidate.name === input.name);
        if (!followUp) return null;
        const text = await followUp.execute(input.args);
        return { text, isError: text.startsWith("Refused.") };
      },
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await app.request("/api/agent-tools/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": TOKEN,
        },
        body: JSON.stringify({
          name,
          args,
          // Ignored: the signed run is the only identity the route believes.
          actorId: STRANGER,
          run: mintRunAssertion(
            {
              botId: ASKER,
              actorId: ACTOR,
              runId: run,
              threadId: `thread-${suite}`,
            },
            KEY,
          ),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { text: string; isError: boolean };
    };

    const scheduled = await call("schedule_follow_up", {
      reason: "check the build",
      in_minutes: 2,
    });
    expect(scheduled.isError).toBe(false);
    const followUpKey = (JSON.parse(scheduled.text) as { scheduled: string })
      .scheduled;
    wakeUpKeys.push(followUpKey);
    const offered = await call(HANDOFF_TOOL, {
      bot: "Target",
      task: "when was the outage",
    });
    expect(offered.isError).toBe(false);
    expect(calledAs).toEqual([ACTOR, ACTOR]);

    // Both rows carry the person the signed run named, and nobody else can read them.
    const mine = sql`(${workItems.kind} = ${WAKE_UP_KIND} and ${workItems.key} = ${followUpKey}) or ${workItems.payload}->>'runId' = ${run}`;
    const queued = await runAsTenant("platform", () =>
      database
        .select({ kind: workItems.kind, tenantId: workItems.tenantId })
        .from(workItems)
        .where(mine),
    );
    expect(queued.map((row) => row.kind).sort()).toEqual(
      ["bot.message", WAKE_UP_KIND].sort(),
    );
    expect(new Set(queued.map((row) => row.tenantId))).toEqual(
      new Set([ACTOR]),
    );
    expect(
      await runAsTenant(STRANGER, () =>
        database.select({ key: workItems.key }).from(workItems).where(mine),
      ),
    ).toEqual([]);
    /*
     * Nor can anybody who is not a person. A read from no frame is refused outright (G01-E; it used
     * to run as `system`), `system` asked for explicitly sees neither row, and `team` is a stamp that
     * cannot be opened as a frame at all.
     */
    const queuedKeys = () =>
      database.select({ key: workItems.key }).from(workItems).where(mine);
    await expectUnframedRefused(queuedKeys);
    expect(await runAsTenant(SYSTEM_TENANT, queuedKeys)).toEqual([]);
    expect(() => runAsTenant(TEAM_TENANT, queuedKeys)).toThrow(
      TenantContextError,
    );

    // And the sweeps run them, as that person.
    const deliveredAs: string[] = [];
    const hops = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: {
        deliver: async ({ work }) => {
          if (work.runId === run) deliveredAs.push(currentTenant());
          return { answer: null };
        },
      },
    });
    const report = await runAsTenant("platform", () => hops.sweep());
    expect(report.delivered).toContain(TARGET);
    expect(deliveredAs).toEqual([ACTOR]);

    await runAsTenant(ACTOR, () =>
      database
        .update(workItems)
        .set({ runAt: new Date(Date.now() - 60_000) })
        .where(
          and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, followUpKey)),
        ),
    );
    expect(await sweepUntil(followUpKey)).toBe("ran");
    expect(turns.filter((turn) => turn.owner === ACTOR)).toEqual([
      { owner: ACTOR, tenant: ACTOR },
    ]);
  });
});
