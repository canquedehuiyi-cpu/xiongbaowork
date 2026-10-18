import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  routines,
  users,
} from "../src/db/schema";
import { createRoutineRoutes } from "../src/routines/routes";
import {
  createRoutineStore,
  MAX_ENABLED_ROUTINES,
} from "../src/routines/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WP-2.2 / spec C4: the autonomous-work page creates a routine in the page.
 *
 * The REST surface deliberately had no create for a reason stated in its own header — turning a sentence
 * into a cron and a channel is what a conversation is for. That reasoning holds for the sentence, and it
 * does not hold for the page: spec C4 asks for 新建 there, and the original product has it. So the route
 * accepts what the form produces (a coworker, an instruction, a schedule) and adds NOTHING of its own:
 * the fifteen-minute floor, the twenty-routine cap, the instruction limits and the "which conversation
 * did you mean" resolution all stay in `store.ts` and `schedule.ts`, because a second copy of a guardrail
 * is a guardrail that drifts. This file therefore runs the REAL store against a real PostgreSQL — a stub
 * here would prove only that the route forwards a call.
 *
 * The one thing the route does add is whose coworker it is: an id belonging to another workspace answers
 * 404, the same answer as an id that does not exist (spec D15), rather than the store's channel sentence —
 * which is a truer message and does not tell the caller that the coworker is real somewhere.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createRoutineStore(database);
const suite = randomUUID().slice(0, 8);
const tenant = `rc-${suite}`;
const stranger = `rc-stranger-${suite}`;
const mine = `${suite}-my-bot`;
const theirs = `${suite}-their-bot`;

const actor = { id: tenant, role: "user" as const };
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

/** The wiring's own shape: may THIS caller use THIS coworker. */
const canUseBot = async (who: { id: string }, agentId: string) =>
  agentId === mine && who.id === tenant;

const routes = createRoutineRoutes(store, requireUser, { canUseBot });

async function post(body: Record<string, unknown>) {
  return runAsTenant(tenant, async () => {
    const response = await routes.request(
      new Request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    // A route that is not mounted answers with Hono's plain "404 Not Found", and the assertion worth
    // making is about the status — so an unparseable body reads as null rather than as a syntax error.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  });
}

/** A conversation of my own, with my coworker in it — what the store resolves a routine onto. */
async function seed() {
  const channelId = `channel_${randomUUID()}`;
  await runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test` });
    await database.insert(agents).values({
      id: mine,
      tenantId: tenant,
      name: "员工",
      type: "built_in",
      configuration: {},
    });
    await database.insert(channels).values({
      id: channelId,
      tenantId: tenant,
      name: "自主工作",
      description: "",
    });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: tenant, tenantId: tenant });
    await database
      .insert(channelAgents)
      .values({ channelId, agentId: mine, tenantId: tenant });
  });
  await runAsTenant(stranger, async () => {
    await database
      .insert(users)
      .values({ id: stranger, email: `${stranger}@example.test` });
    await database.insert(agents).values({
      id: theirs,
      tenantId: stranger,
      name: "别人的员工",
      type: "built_in",
      configuration: {},
    });
  });
  return channelId;
}

const channelId = await seed();

afterAll(async () => {
  for (const owner of [tenant, stranger]) {
    await runAsTenant(owner, async () => {
      await database.delete(routines).where(eq(routines.ownerUserId, owner));
      await database
        .delete(channelAgents)
        .where(eq(channelAgents.channelId, channelId));
      await database
        .delete(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId));
      await database.delete(channels).where(eq(channels.id, channelId));
      await database.delete(agents).where(eq(agents.tenantId, owner));
      await database.delete(users).where(eq(users.id, owner));
    });
  }
  await database.$client.end({ timeout: 5 });
});

test("the page's form creates a standing instruction and answers with what it made", async () => {
  const { status, body } = await post({
    agentId: mine,
    instruction: "每天早九点把昨天的提交汇总一下",
    cron: "0 9 * * *",
  });
  expect(status).toBe(201);
  expect(body.routine.id.startsWith("routine_")).toBe(true);
  expect(body.routine.instruction).toBe("每天早九点把昨天的提交汇总一下");
  // The words, not the expression: the client never parses a schedule.
  expect(body.routine.schedule).toBe("Every day at 09:00");
  expect(body.routine.channel.id).toBe(channelId);
  expect(Number.isNaN(Date.parse(body.routine.nextRunAt))).toBe(false);
  expect(body.routine.enabled).toBe(true);

  const stored = await runAsTenant(tenant, async () =>
    database
      .select({ id: routines.id })
      .from(routines)
      .where(eq(routines.ownerUserId, tenant)),
  );
  expect(stored.length).toBe(1);
});

test("a schedule under the fifteen-minute floor is refused by the store's own rule", async () => {
  const { status, body } = await post({
    agentId: mine,
    instruction: "每分钟看一次",
    cron: "* * * * *",
  });
  expect(status).toBe(400);
  // The sentence is `schedule.ts`'s, carried through verbatim — not one the route invented.
  expect(body.error).toBe("Routines may run at most every 15 minutes.");
});

test("the twenty-first enabled routine is a conflict, not a bad request", async () => {
  // The cap counts what the owner HAS, and the cases above already created some — so the run starts from
  // an empty slate rather than from whatever the earlier ones left, which is the difference between
  // asserting the cap and asserting the file's order.
  await runAsTenant(tenant, async () => {
    await database.delete(routines).where(eq(routines.ownerUserId, tenant));
  });
  for (let index = 0; index < MAX_ENABLED_ROUTINES; index++) {
    const { status } = await post({
      agentId: mine,
      instruction: `第 ${index + 1} 条`,
      cron: "0 9 * * *",
    });
    expect(status).toBe(201);
  }
  const { status, body } = await post({
    agentId: mine,
    instruction: "再多一条",
    cron: "0 9 * * *",
  });
  // 409 because nothing in what the caller SENT is wrong: the month's allowance of standing
  // instructions is used up, and the screen's answer to that is "switch one off", not "fix your cron".
  expect(status).toBe(409);
  expect(body.error).toContain(`${MAX_ENABLED_ROUTINES} routines switched on`);
});

test("another workspace's coworker answers as if it were not there", async () => {
  const { status } = await post({
    agentId: theirs,
    instruction: "替别人干点活",
    cron: "0 9 * * *",
  });
  expect(status).toBe(404);
  // …and it did not create anything under my name.
  const stored = await runAsTenant(tenant, async () =>
    database
      .select({ id: routines.id })
      .from(routines)
      .where(eq(routines.agentId, theirs)),
  );
  expect(stored.length).toBe(0);
});

test("an instruction with nothing in it is refused before the store is asked", async () => {
  const { status } = await post({
    agentId: mine,
    instruction: "   ",
    cron: "0 9 * * *",
  });
  expect(status).toBe(400);
  const missingCron = await post({ agentId: mine, instruction: "说点什么" });
  expect(missingCron.status).toBe(400);
});
