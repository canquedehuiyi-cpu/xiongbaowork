import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { HANDOFF_KIND } from "../src/agents/handoff";
import {
  BotPausedError,
  configureBotLifecycle,
  createBotLifecycleStore,
  guardBotTurn,
  isBotPaused,
  resetBotLifecycleForTests,
  resolveUpdateRoute,
} from "../src/agents/lifecycle";
import { createBotReset } from "../src/agents/lifecycle-reset";
import {
  createWakeUpStore,
  WAKE_UP_KIND,
  WAKE_UP_MAX_PENDING,
  WakeUpRefusedError,
  wakeUpTools,
} from "../src/agents/wake-up";
import { createDatabase } from "../src/db/client";
import { approvalRequests, approvalRules } from "../src/db/schema/approvals";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema/core";
import { agentProfiles, routines } from "../src/db/schema/coworker";
import { groupMessages } from "../src/db/schema/group";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { responsibilities } from "../src/db/schema/responsibilities";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { workItems } from "../src/db/schema/work";
import { createRoutineRunner } from "../src/routines/runner";
import { runAsTenant, TenantContextError } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Pause, reset, Activity, attention, follow-ups and update routing against a real PostgreSQL.
 *
 * Every assertion that something was deleted or counted is paired with one that the other person's
 * identical data was not: "never touches other users' data" is the property, and a test that only
 * looks at the owner's rows cannot tell a scoped delete from a table-wide one.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `lifecycle-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const helper = `${prefix}-helper`;
const direct = `${prefix}-direct`;
const shared = `${prefix}-shared`;
const othersDirect = `${prefix}-others-direct`;

/** A person's rows are written and read in that person's own frame, as their requests would be. */
const as = <T>(person: string, fn: () => T): T => runAsTenant(person, fn);
/**
 * The platform's frame sees every person's rows, so a call made in it is kept to one person by the
 * application's own filters rather than by the row-level policy. "Only this person's" checks run in
 * both frames: the person's own, as their request would, and the platform's, which would fail if
 * the application stopped filtering by person.
 */
const asPlatform = <T>(fn: () => T): T => runAsTenant("platform", fn);

beforeAll(async () => {
  configureBotLifecycle({ database });
  for (const person of [owner, other])
    await as(person, () =>
      database
        .insert(users)
        .values({ id: person, email: `${person}@example.test` }),
    );
  // The Bots are the owner's (their profiles name the owner), and so is the direct conversation.
  await as(owner, async () => {
    await database.insert(agents).values([
      { id: bot, name: "Lifecycle Bot", type: "built_in", configuration: {} },
      { id: helper, name: "Helper Bot", type: "built_in", configuration: {} },
    ]);
    await database.insert(agentProfiles).values(
      [bot, helper].map((agentId) => ({
        agentId,
        ownerUserId: owner,
        title: agentId,
        roleDescription: "Test",
        avatarSeed: agentId,
        visibility: "public" as const,
      })),
    );
  });
  for (const [person, channelId] of [
    [owner, direct],
    [other, othersDirect],
  ] as const)
    await as(person, async () => {
      await database.insert(channels).values({
        id: channelId,
        name: channelId,
        description: "",
        lastMessage: "hello",
        lastMessageAt: new Date(),
        lastMessageAgentId: bot,
      });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: person });
      await database.insert(channelAgents).values({ channelId, agentId: bot });
    });
  /*
   * The conversation both people are in is a shared group, stamped `team` (G01-E P11), and written
   * the way the channel store writes one: from the owner's frame, the channel first (the database
   * stamps its creator from that frame), then the owner's own membership, then the other person's
   * (the owner is a member by then), then the Bot. Each person reads it in their own frame: the
   * owner's reset plan counts the other member, and the other person's attention counts it unread.
   */
  await as(owner, async () => {
    await database.insert(channels).values({
      id: shared,
      tenantId: TEAM_TENANT,
      name: shared,
      description: "",
      lastMessage: "hello",
      lastMessageAt: new Date(),
      lastMessageAgentId: bot,
    });
    await database
      .insert(channelMemberships)
      .values({ channelId: shared, userId: owner, tenantId: TEAM_TENANT });
    await database
      .insert(channelMemberships)
      .values({ channelId: shared, userId: other, tenantId: TEAM_TENANT });
    await database
      .insert(channelAgents)
      .values({ channelId: shared, agentId: bot, tenantId: TEAM_TENANT });
    await database.insert(groupMessages).values({
      id: `${prefix}-shared-line`,
      channelId: shared,
      ownerUserId: owner,
      text: "hello",
      tenantId: TEAM_TENANT,
    });
  });
  for (const person of [owner, other])
    await as(person, async () => {
      await database.insert(routines).values({
        id: `${prefix}-routine-${person}`,
        ownerUserId: person,
        agentId: bot,
        channelId: person === owner ? direct : othersDirect,
        instruction: "Summarise the day",
        cron: "0 9 * * *",
        nextRunAt: new Date(Date.now() + 3_600_000),
      });
      await database.insert(responsibilities).values({
        id: `${prefix}-goal-${person}`,
        ownerUserId: person,
        agentId: bot,
        channelId: person === owner ? direct : othersDirect,
        threadId: `${prefix}-thread-${person}`,
        title: "Keep the build green",
        instruction: "Watch CI",
        successCriteria: "Green",
      });
      await database.insert(memorySources).values({
        id: `${prefix}-source-${person}`,
        ownerUserId: person,
        agentId: bot,
        toolRef: "docs/read",
        title: "Docs",
      });
      await database.insert(personalMemories).values([
        {
          id: `${prefix}-memory-${person}-1`,
          ownerUserId: person,
          sourceId: `${prefix}-source-${person}`,
          content: "Launch is Tuesday",
          provenance: "Docs",
        },
        // A memory of the person's own, from no source: not this Bot's, so a reset keeps it.
        {
          id: `${prefix}-memory-${person}-own`,
          ownerUserId: person,
          content: "Prefers mornings",
          provenance: "You",
        },
      ]);
    });
  // Each queued item is the tenant of the person it acts for, as the frame that offered it stamps it.
  await as(owner, async () => {
    await database.insert(workItems).values([
      {
        kind: HANDOFF_KIND,
        key: `${prefix}-hop-queued`,
        payload: {
          fromBotId: bot,
          toBotId: helper,
          actorId: owner,
          threadId: `${prefix}-thread-${owner}`,
          task: "Find the invoice",
          toName: "Helper Bot",
        },
      },
      {
        kind: HANDOFF_KIND,
        key: `${prefix}-hop-gave-up`,
        attempts: 5,
        payload: {
          fromBotId: bot,
          toBotId: helper,
          actorId: owner,
          threadId: `${prefix}-thread-${owner}`,
          task: "Check the contract",
        },
      },
      {
        kind: "person.question",
        key: `${prefix}-question`,
        payload: {
          actorId: owner,
          botId: bot,
          threadId: `${prefix}-thread-${owner}`,
          runId: "r1",
          question: "Which account?",
          mode: "completed_question",
          channelId: direct,
        },
      },
    ]);
    await database.insert(approvalRequests).values({
      id: `${prefix}-approval`,
      ownerUserId: owner,
      runId: "r1",
      toolCallId: "t1",
      actionDigest: "d",
      action: {
        actorId: owner,
        botId: bot,
        toolRef: "mail/send",
        effect: "send",
        scope: "once",
        args: {},
        runId: "r1",
        threadId: `${prefix}-thread-${owner}`,
        toolCallId: "t1",
        actionDigest: "d",
      },
    });
  });
  await as(other, () =>
    database.insert(workItems).values({
      kind: HANDOFF_KIND,
      key: `${prefix}-hop-others`,
      payload: {
        fromBotId: bot,
        toBotId: helper,
        actorId: other,
        threadId: `${prefix}-thread-${other}`,
        task: "Not yours",
      },
    }),
  );
});

afterAll(async () => {
  resetBotLifecycleForTests();
  // As the platform: the fixture spans both people's tenants.
  await runAsTenant("platform", async () => {
    await database
      .delete(workItems)
      .where(sql`${workItems.key} like ${`%${prefix}%`}`);
    await database
      .delete(approvalRequests)
      .where(eq(approvalRequests.ownerUserId, owner));
    await database
      .delete(channels)
      .where(inArray(channels.id, [direct, shared, othersDirect]));
    await database.delete(agents).where(inArray(agents.id, [bot, helper]));
    await database.delete(users).where(inArray(users.id, [owner, other]));
  });
});

describe("pause", () => {
  const lifecycle = createBotLifecycleStore(database);

  test("pausing is one person's, and a headless turn refuses to start", async () => {
    await as(owner, () => lifecycle.pause(owner, bot));
    expect(await as(owner, () => isBotPaused(owner, bot))).toBe(true);
    expect(await as(other, () => isBotPaused(other, bot))).toBe(false);
    expect(await asPlatform(() => isBotPaused(other, bot))).toBe(false);
    await expect(
      as(owner, () => guardBotTurn({ ownerUserId: owner, agentId: bot })),
    ).rejects.toBeInstanceOf(BotPausedError);
    await as(owner, () => lifecycle.resume(owner, bot));
    expect(await as(owner, () => isBotPaused(owner, bot))).toBe(false);
  });

  test("pausing stops the turn that is running", async () => {
    const signal = await as(owner, () =>
      guardBotTurn({ ownerUserId: owner, agentId: bot }),
    );
    const othersSignal = await as(other, () =>
      guardBotTurn({
        ownerUserId: other,
        agentId: bot,
      }),
    );
    expect(signal.aborted).toBe(false);
    expect(await as(owner, () => lifecycle.pause(owner, bot))).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(othersSignal.aborted).toBe(false);
    await as(owner, () => lifecycle.resume(owner, bot));
  });

  test("a routine firing for a paused Bot is skipped, never run", async () => {
    await as(owner, () => lifecycle.pause(owner, bot));
    const finished: [string, string, string | undefined][] = [];
    let ran = false;
    const runner = createRoutineRunner({
      routineStore: {
        runContext: async () => ({
          routineId: "r",
          ownerUserId: owner,
          tenantId: owner,
          agentId: bot,
          channelId: direct,
          instruction: "x",
          enabled: true,
        }),
        finishRun: async (id: string, status: string, reason?: string) =>
          void finished.push([id, status, reason]),
      } as never,
      channelStore: {
        get: async () => ({ id: direct, threadId: "t" }),
        recordActivity: async () => {},
      } as never,
      runTurn: async () => {
        ran = true;
        return { replyText: "no" };
      },
    });
    await runner.run("run-1");
    expect(ran).toBe(false);
    expect(finished[0]?.[1]).toBe("skipped");
    await as(owner, () => lifecycle.resume(owner, bot));
  });
});

describe("Activity and attention", () => {
  const activity = createActivityStore(database);

  test("sections hold the owner's work and nobody else's", async () => {
    for (const result of [
      await as(owner, () => activity.forBot(owner, bot)),
      await asPlatform(() => activity.forBot(owner, bot)),
    ]) {
      const all = [
        ...result.inProgress,
        ...result.scheduled,
        ...result.completed,
      ];
      expect(all.some((item) => item.title === "Not yours")).toBe(false);
      expect(
        result.scheduled.some(
          (item) => item.kind === "routine" && item.channelId === direct,
        ),
      ).toBe(true);
      expect(
        result.scheduled.some(
          (item) => item.kind === "handoff" && item.stoppable,
        ),
      ).toBe(true);
      expect(
        result.inProgress.some(
          (item) => item.kind === "approval" && item.needsYou,
        ),
      ).toBe(true);
      expect(
        result.inProgress.some(
          (item) => item.kind === "question" && item.channelId === direct,
        ),
      ).toBe(true);
      expect(
        result.inProgress.some(
          (item) => item.kind === "handoff" && item.status === "failed",
        ),
      ).toBe(true);
    }
  });

  test("attention counts what waits on this person", async () => {
    for (const frame of [owner, "platform"]) {
      const [row] = (await as(frame, () => activity.attention(owner))).filter(
        (entry) => entry.agentId === bot,
      );
      expect(row).toMatchObject({
        questions: 1,
        approvals: 1,
        handoffs: 1,
        unread: 2,
      });
    }
    for (const frame of [other, "platform"]) {
      const [others] = (
        await as(frame, () => activity.attention(other))
      ).filter((entry) => entry.agentId === bot);
      expect(others).toMatchObject({ questions: 0, approvals: 0, unread: 2 });
    }
  });

  test("stopping a delegated task finishes only that person's hop", async () => {
    for (const frame of [other, "platform"])
      expect(
        await as(frame, () =>
          activity.stopHandoff(other, bot, `${prefix}-hop-queued`),
        ),
      ).toBeNull();
    const stopped = await as(owner, () =>
      activity.stopHandoff(owner, bot, `${prefix}-hop-queued`),
    );
    expect(stopped?.toBotId).toBe(helper);
    const result = await as(owner, () => activity.forBot(owner, bot));
    expect(
      result.completed.find((item) => item.id === `${prefix}-hop-queued`)
        ?.status,
    ).toBe("stopped");
  });
});

describe("follow-ups", () => {
  const wakeUps = createWakeUpStore(database);
  /*
   * Scheduling, listing and cancelling run in the person's own frame, the way a turn's tool call
   * does (POST /api/agent-tools/call runs as the signed run's actor). The follow-up row is stamped
   * with that tenant, and the sweep later runs it as exactly that tenant (G01).
   */
  const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);
  const asOther = <T>(fn: () => Promise<T>) => runAsTenant(other, fn);

  test("are bounded in time and in number, and cancellable", async () => {
    await expect(
      asOwner(() =>
        wakeUps.schedule({
          ownerUserId: owner,
          agentId: bot,
          reason: "too soon",
          dueAt: new Date(Date.now() + 1_000),
        }),
      ),
    ).rejects.toBeInstanceOf(WakeUpRefusedError);
    await expect(
      asOwner(() =>
        wakeUps.schedule({
          ownerUserId: owner,
          agentId: bot,
          reason: "too late",
          dueAt: new Date(Date.now() + 8 * 24 * 3_600_000),
        }),
      ),
    ).rejects.toBeInstanceOf(WakeUpRefusedError);

    const [tool] = wakeUpTools({
      store: wakeUps,
      ownerUserId: owner,
      agentId: bot,
    });
    const answers: string[] = [];
    for (let i = 0; i <= WAKE_UP_MAX_PENDING; i += 1)
      answers.push(
        await asOwner(() =>
          tool!.execute({ reason: `check ${i}`, in_minutes: 60 }),
        ),
      );
    expect(answers.filter((a) => a.startsWith("Refused."))).toHaveLength(1);

    const scheduled = (
      await asOwner(() => createActivityStore(database).forBot(owner, bot))
    ).scheduled.filter((item) => item.kind === "follow_up");
    expect(scheduled).toHaveLength(WAKE_UP_MAX_PENDING);
    expect(scheduled.every((item) => item.cancellable)).toBe(true);

    expect(
      await asOther(() => wakeUps.cancel(other, bot, scheduled[0]!.id)),
    ).toBe(false);
    expect(
      await asOwner(() => wakeUps.cancel(owner, bot, scheduled[0]!.id)),
    ).toBe(true);
    expect(
      await asOwner(() => wakeUps.cancel(owner, bot, scheduled[0]!.id)),
    ).toBe(false);
  });

  test("land in the scheduling person's tenant, which nobody else reads", async () => {
    const record = await asOwner(() =>
      wakeUps.schedule({
        ownerUserId: owner,
        agentId: helper,
        reason: "tenant check",
        dueAt: new Date(Date.now() + 2 * 3_600_000),
      }),
    );
    const stamped = await asOwner(() =>
      database
        .select({ tenantId: workItems.tenantId })
        .from(workItems)
        .where(
          and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, record.id)),
        ),
    );
    expect(stamped).toEqual([{ tenantId: owner }]);
    // The other tenant reads none of it, at the row level and through the store.
    expect(
      await asOther(() =>
        database
          .select({ key: workItems.key })
          .from(workItems)
          .where(
            and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, record.id)),
          ),
      ),
    ).toHaveLength(0);
    expect(await asOther(() => wakeUps.list(owner, helper))).toHaveLength(0);
    expect(
      (await asOwner(() => wakeUps.list(owner, helper))).map((r) => r.id),
    ).toContain(record.id);
  });

  test("are never scheduled outside the person's own frame", async () => {
    const input = {
      ownerUserId: owner,
      agentId: helper,
      reason: "untrusted",
      dueAt: new Date(Date.now() + 3 * 3_600_000),
    };
    // Unframed (would be stamped `system`), the platform's frame, and another person's frame.
    await expect(wakeUps.schedule(input)).rejects.toBeInstanceOf(
      TenantContextError,
    );
    await expect(
      runAsTenant("platform", () => wakeUps.schedule(input)),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      runAsTenant("system", () => wakeUps.schedule(input)),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(asOther(() => wakeUps.schedule(input))).rejects.toBeInstanceOf(
      TenantContextError,
    );
    // The tool says so as a refusal rather than throwing into the turn.
    const [tool] = wakeUpTools({
      store: wakeUps,
      ownerUserId: owner,
      agentId: helper,
    });
    expect(
      await asOther(() => tool!.execute({ reason: "x", in_minutes: 60 })),
    ).toStartWith("Refused.");
    const rows = await runAsTenant("platform", () =>
      database
        .select({ payload: workItems.payload })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            sql`${workItems.key} like ${`%${prefix}%`}`,
          ),
        ),
    );
    expect(
      rows.filter(
        (row) =>
          (row.payload as { reason?: string }).reason === "untrusted" ||
          (row.payload as { reason?: string }).reason === "x",
      ),
    ).toHaveLength(0);
  });
});

describe("update routing", () => {
  const lifecycle = createBotLifecycleStore(database);

  test("per-Bot notify and per-kind transports decide what leaves the web", async () => {
    await as(owner, async () => {
      let route = await resolveUpdateRoute({
        ownerUserId: owner,
        agentId: bot,
        kind: "reply",
      });
      expect(route.allows("push")).toBe(true);

      await lifecycle.setRouting(owner, "question", ["slack"]);
      route = await resolveUpdateRoute({
        ownerUserId: owner,
        agentId: bot,
        kind: "question",
      });
      expect(route.allows("slack")).toBe(true);
      expect(route.allows("push")).toBe(false);

      await lifecycle.setNotify(owner, bot, "needs_input");
      expect(
        (
          await resolveUpdateRoute({
            ownerUserId: owner,
            agentId: bot,
            kind: "reply",
          })
        ).notify,
      ).toBe(false);
      expect(
        (
          await resolveUpdateRoute({
            ownerUserId: owner,
            agentId: bot,
            kind: "approval",
          })
        ).allows("sms"),
      ).toBe(true);

      await lifecycle.setNotify(owner, bot, "none");
      expect(
        (
          await resolveUpdateRoute({
            ownerUserId: owner,
            agentId: bot,
            kind: "question",
          })
        ).allows("slack"),
      ).toBe(false);
      // Somebody else's preferences are untouched.
      for (const frame of [other, "platform"])
        expect(
          (
            await as(frame, () =>
              resolveUpdateRoute({
                ownerUserId: other,
                agentId: bot,
                kind: "question",
              }),
            )
          ).allows("push"),
        ).toBe(true);
      await lifecycle.setNotify(owner, bot, "all");
      await lifecycle.setRouting(owner, "question", "all");
    });
  });
});

describe("reset", () => {
  const softDeleted: string[] = [];
  const reset = createBotReset({
    database,
    softDeleteChannel: async (_actor, channelId) => {
      softDeleted.push(channelId);
      await database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channelId));
    },
  });

  test("the notice counts per kind, and the reset deletes only the owner's", async () => {
    /*
     * The follow-ups are stamped with the owner (the "follow-ups" block schedules them in the
     * owner's frame, G01), and so is the owner's part of this file's seed. The plan is read in the
     * owner's frame; the reset runs as the platform, which sees the other person's identical rows
     * too, so it is the reset's own per-person filters (not the row-level policy) that the
     * survivor checks below hold to.
     */
    const plan = await runAsTenant(owner, () => reset.plan(owner, bot));
    expect(plan).toMatchObject({
      conversations: 1,
      sharedConversationsKept: 1,
      memorySources: 1,
      memories: 1,
      routines: 1,
      responsibilities: 1,
    });
    expect(plan.followUps).toBeGreaterThan(0);

    const deleted = await asPlatform(() =>
      reset.execute({ id: owner, role: "user" }, bot),
    );
    expect(deleted).toEqual(plan);
    expect(softDeleted).toEqual([direct]);
    expect(
      await runAsTenant(owner, () => reset.plan(owner, bot)),
    ).toMatchObject({
      conversations: 0,
      memories: 0,
      routines: 0,
      responsibilities: 0,
      followUps: 0,
    });

    // The other person's identical data survives, and so does the owner's own memory.
    expect(await as(other, () => reset.plan(other, bot))).toMatchObject({
      conversations: 1,
      memories: 1,
      routines: 1,
      responsibilities: 1,
    });
    const kept = await as(owner, () =>
      database
        .select({ id: personalMemories.id })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, owner),
            eq(personalMemories.id, `${prefix}-memory-${owner}-own`),
          ),
        ),
    );
    expect(kept).toHaveLength(1);
    const [sharedRow] = await as(owner, () =>
      database
        .select({ deletedAt: channels.deletedAt })
        .from(channels)
        .where(eq(channels.id, shared)),
    );
    expect(sharedRow?.deletedAt).toBeNull();
    // The other member reads the same row, in their own frame, and it is still there for them too.
    const [othersRow] = await as(other, () =>
      database
        .select({ deletedAt: channels.deletedAt })
        .from(channels)
        .where(eq(channels.id, shared)),
    );
    expect(othersRow).toEqual({ deletedAt: null });
    // It is the team's row, not either person's.
    const [stamped] = await asPlatform(() =>
      database
        .select({ tenantId: channels.tenantId })
        .from(channels)
        .where(eq(channels.id, shared)),
    );
    expect(stamped?.tenantId).toBe(TEAM_TENANT);
    // And somebody who is not in it reads none of it: not the channel, its people or its lines.
    const outsider = `${prefix}-outsider`;
    const outside = await as(outsider, async () => ({
      channels: await database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, shared)),
      memberships: await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, shared)),
      messages: await database
        .select({ id: groupMessages.id })
        .from(groupMessages)
        .where(eq(groupMessages.channelId, shared)),
    }));
    expect(outside).toEqual({ channels: [], memberships: [], messages: [] });
    // Read as the platform, so a follow-up of any stamp that survived would be seen.
    const remaining = await runAsTenant("platform", () =>
      database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            sql`${workItems.finishedAt} is null`,
            sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
            sql`${workItems.payload}->>'agentId' = ${bot}`,
          ),
        ),
    );
    expect(remaining).toHaveLength(0);
  });

  test("a reset also takes what the Bot formed, its research and the permissions it was given", async () => {
    for (const person of [owner, other])
      await as(person, async () => {
        await database.insert(personalMemories).values({
          id: `${prefix}-formed-${person}`,
          ownerUserId: person,
          content: "Owns the billing service",
          provenance: "Read from GitHub",
          formedBy: "bot",
          formedByAgentId: bot,
        });
        await database.insert(proactiveSettings).values({
          id: `${prefix}-research-${person}`,
          ownerUserId: person,
          agentId: bot,
          channelId: person === owner ? direct : othersDirect,
          threadId: `${prefix}-research-thread-${person}`,
        });
        await database.insert(proactiveSuggestions).values({
          id: `${prefix}-suggestion-${person}`,
          ownerUserId: person,
          agentId: bot,
          settingId: `${prefix}-research-${person}`,
          runId: "run-1",
          title: "Review the PR",
          detail: "It waits on you",
        });
        await database.insert(approvalRules).values([
          {
            id: `${prefix}-allow-${person}`,
            ownerUserId: person,
            botId: bot,
            toolRef: "mail/send",
            effect: "send",
            scope: "*",
            behaviour: "allow",
          },
          // A rule that makes the Bot ask first protects the person, so a reset leaves it.
          {
            id: `${prefix}-ask-${person}`,
            ownerUserId: person,
            botId: bot,
            toolRef: "files/delete",
            effect: "delete",
            scope: "*",
            behaviour: "ask",
          },
        ]);
      });

    const plan = await as(owner, () => reset.plan(owner, bot));
    expect(plan).toMatchObject({
      formedMemories: 1,
      backgroundResearch: 1,
      standingApprovals: 1,
    });
    // As the platform, so the other person's rows are within reach and only the filters spare them.
    expect(
      await asPlatform(() => reset.execute({ id: owner, role: "user" }, bot)),
    ).toEqual(plan);
    expect(await as(owner, () => reset.plan(owner, bot))).toMatchObject({
      formedMemories: 0,
      backgroundResearch: 0,
      standingApprovals: 0,
    });

    // Each person's rows, read in that person's frame.
    const left = (table: "memory" | "research" | "rules", person: string) =>
      as(person, () =>
        table === "memory"
          ? database
              .select({ id: personalMemories.id })
              .from(personalMemories)
              .where(eq(personalMemories.id, `${prefix}-formed-${person}`))
          : table === "research"
            ? database
                .select({ id: proactiveSuggestions.id })
                .from(proactiveSuggestions)
                .where(eq(proactiveSuggestions.ownerUserId, person))
            : database
                .select({ id: approvalRules.id })
                .from(approvalRules)
                .where(
                  and(
                    eq(approvalRules.ownerUserId, person),
                    sql`${approvalRules.revokedAt} is null`,
                  ),
                ),
      );
    expect(await left("memory", owner)).toHaveLength(0);
    expect(await left("research", owner)).toHaveLength(0);
    expect((await left("rules", owner)).map((row) => row.id)).toEqual([
      `${prefix}-ask-${owner}`,
    ]);
    // The other person's identical rows survive.
    expect(await left("memory", other)).toHaveLength(1);
    expect(await left("research", other)).toHaveLength(1);
    expect(await left("rules", other)).toHaveLength(2);
    expect(await as(other, () => reset.plan(other, bot))).toMatchObject({
      formedMemories: 1,
      backgroundResearch: 1,
      standingApprovals: 1,
    });
  });
});
