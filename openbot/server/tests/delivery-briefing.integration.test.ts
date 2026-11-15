import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  deliveryBindings,
  deliveryOutbox,
  pushDevices,
  taskBriefings,
  taskEvents,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { createExpoPushTransport } from "../src/delivery/push";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryStore } from "../src/delivery/store";
import type {
  BindingTransport,
  DeliveryKind,
  DeliveryScope,
} from "../src/delivery/types";
import {
  type Briefing,
  type BriefingKind,
  createBriefingRoutes,
  createBriefings,
  createTaskNotices,
} from "../src/tasks/briefing";
import { createDelivery } from "../src/tasks/delivery";
import {
  type DeliveryCheckDeps,
  localDay,
  runDeliveryCheck,
  savedWorkHours,
} from "../src/tasks/delivery-checker";
import { listTaskEvents, taskEventSentence } from "../src/tasks/events";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import {
  createUserPreferencesStore,
  readWorkHours,
} from "../src/user-preferences";
import { userPreferencesRoutes } from "../src/user-preferences-routes";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 开工 / 收工清点与通知出口 (spec 2026-11-15-delivery-loop §10): the person's work hours, the briefing
 * built from their followed cards, the minute pass that sends it once per local day, and the way out
 * for the delivery checker's reminders -- push, and a bound Slack / Teams / SMS.
 *
 * The real database throughout (cards, history, the briefing claims, the outbox and its work items),
 * the real delivery router and store, the real Expo transport; the providers' wires are the only fakes.
 * The clock is injected everywhere. Which conversations a person can reach is the server's rule
 * (`deliveryScopeFor`), modelled as the channels each person here owns.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const delivery = createDelivery(database);
const deliveries = createDeliveryStore(database);
const suite = randomUUID().slice(0, 8);
const people: string[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
/** Monday 2026-11-16, 09:00 in Shanghai. */
const MONDAY_9 = new Date("2026-11-16T01:00:00.000Z");
/** Saturday 2026-11-21, 09:00 in Shanghai. */
const SATURDAY_9 = new Date("2026-11-21T01:00:00.000Z");

/** Each person's one conversation with their coworker: channel → its owner and coworker. */
const conversations = new Map<string, { owner: string; agentId: string }>();
const threadOf = (channelId: string) => `${channelId}-thread`;
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
): Promise<DeliveryScope | null> => {
  const known = conversations.get(channelId);
  return known?.owner === ownerUserId && known.agentId === agentId
    ? { ownerUserId, channelId, agentId, threadId: threadOf(channelId) }
    : null;
};

const chatSends: {
  transport: BindingTransport;
  address: string;
  text: string;
}[] = [];
const pushSends: {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}[] = [];
const chat = (transport: BindingTransport) => ({
  send: async (input: { id: string; address: string; text: string }) => {
    chatSends.push({ transport, address: input.address, text: input.text });
    return { id: `${transport}-${chatSends.length}`, status: "sent" as const };
  },
});
const router = createDeliveryRouter({
  store: deliveries,
  queue: createWorkQueue(database),
  owner: `briefing-delivery-${suite}`,
  authoriseScope: async (scope) =>
    (await scopeFor(scope.ownerUserId, scope.channelId, scope.agentId))
      ?.threadId === scope.threadId,
  scopeFor,
  runTurn: async () => ({ replyText: "" }),
  providers: {
    slack: chat("slack"),
    teams: chat("teams"),
    sms: chat("sms"),
    push: createExpoPushTransport({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.to) pushSends.push(body);
        return Response.json({
          data: { status: "ok", id: `ticket-${pushSends.length}` },
        });
      },
    }),
  },
});
const notices = createTaskNotices({
  database,
  router,
  scopeFor,
  workHours: savedWorkHours(database),
});

type Person = {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string;
};

/** A person with one coworker (小财) and their conversation with it; `preferences` as saved. */
async function person(
  label: string,
  preferences?: Record<string, unknown>,
): Promise<Person> {
  const id = `db-${label}-${suite}`;
  const agentId = `db-agent-${label}-${suite}`;
  const channelId = `db-ch-${label}-${suite}`;
  await runAsTenant(id, async () => {
    await database.insert(users).values({
      id,
      email: `${id}@example.test`,
      ...(preferences ? { preferences } : {}),
    });
    await database.insert(agents).values({
      id: agentId,
      name: "小财",
      type: "built_in",
      configuration: {},
    });
    await database
      .insert(channels)
      .values({ id: channelId, name: "单聊", description: "" });
  });
  conversations.set(channelId, { owner: id, agentId });
  people.push(id);
  return { id, agentId, channelId, threadId: threadOf(channelId) };
}

/** A phone of theirs, for push. */
async function phone(who: Person): Promise<string> {
  const id = `db-phone-${randomUUID()}`;
  await runAsTenant(who.id, () =>
    deliveries.registerDevice({
      id,
      ownerUserId: who.id,
      token: `ExponentPushToken[${id}]`,
      projectId: randomUUID(),
      platform: "ios",
    }),
  );
  return id;
}

/** A chat account of theirs bound to their conversation with the coworker. */
async function bound(who: Person, transport: BindingTransport) {
  return runAsTenant(who.id, () =>
    deliveries.bind({
      ownerUserId: who.id,
      channelId: who.channelId,
      agentId: who.agentId,
      threadId: who.threadId,
      transport,
      realm: `${suite}-${who.id}`,
      identity: `${transport}-${who.id}`,
      address: `${transport}-address-${who.id}`,
    }),
  );
}

/** A card in their conversation; followed and open (`running`) unless said otherwise. */
async function card(
  who: Person,
  input: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const [row] = await runAsTenant(who.id, () =>
    database
      .insert(tasks)
      .values({
        title: "核对发票",
        source: "chat",
        status: "running",
        tracked: true,
        executorAgentId: who.agentId,
        channelRef: who.channelId,
        threadRef: who.threadId,
        ...input,
      })
      .returning({ id: tasks.id }),
  );
  if (!row) throw new Error("no card");
  return row.id;
}

/** One line of a card's history, at the test's clock rather than the wall's. */
const line = (
  who: Person,
  taskId: string,
  kind: "delivered" | "reviewed",
  createdAt: Date,
) =>
  runAsTenant(who.id, () =>
    database.insert(taskEvents).values({
      tenantId: who.id,
      taskId,
      kind,
      actor: kind === "reviewed" ? `user:${who.id}` : "system",
      detail: {},
      createdAt,
    }),
  );

/** What was queued to reach this person, of `kind`. */
const outbox = (who: Person, kind?: DeliveryKind) =>
  runAsTenant(who.id, () =>
    database
      .select()
      .from(deliveryOutbox)
      .where(
        and(
          eq(deliveryOutbox.ownerUserId, who.id),
          ...(kind ? [eq(deliveryOutbox.kind, kind)] : []),
        ),
      ),
  );

const cardRow = async (who: Person, taskId: string) => {
  const [found] = await runAsTenant(who.id, () =>
    database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, who.id), eq(tasks.id, taskId))),
  );
  if (!found) throw new Error("card gone");
  return found;
};

/** Send everything queued for these people (the router claims one item a sweep). */
async function sweep(...who: Person[]) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const waiting = (await Promise.all(who.map((person) => outbox(person))))
      .flat()
      .filter((row) => row.state === "queued");
    if (waiting.length === 0) return;
    await router.sweep("delivery.outbound");
  }
  throw new Error("outbox did not drain");
}

/** The briefing pass for these people, with a `send` that counts. */
function briefingsFor(who: Person[]) {
  const sent: { tenantId: string; kind: BriefingKind; briefing: Briefing }[] =
    [];
  const briefings = createBriefings({
    database,
    workHours: savedWorkHours(database),
    agentName: async () => "小财",
    send: async (tenantId, kind, briefing, now) => {
      sent.push({ tenantId, kind, briefing });
      return notices.sendBriefing(tenantId, kind, briefing, now);
    },
    onlyTenants: who.map((person) => person.id),
  });
  return { ...briefings, sent };
}

/** The delivery checker over these people, with the real way out and a nudge that counts. */
function checkerFor(who: Person[]) {
  const nudges: string[] = [];
  const deps: DeliveryCheckDeps = {
    database,
    workHours: savedWorkHours(database),
    notify: (tenantId, notice, now) => notices.notify(tenantId, notice, now),
    nudge: async (tenantId, taskId, text) => {
      nudges.push(taskId);
      await delivery.nudged(tenantId, taskId, {
        actor: "system",
        text,
        at: new Date(),
        day: localDay(new Date(), "Asia/Shanghai"),
      });
      return "skipped_running";
    },
    turnRunning: async () => false,
    agentName: async () => "小财",
    onlyTenants: who.map((person) => person.id),
  };
  return { nudges, check: (now: Date) => runDeliveryCheck(deps, now) };
}

const asUser =
  (userId: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.test`,
      role: "user" as const,
    });
    await runAsTenant(userId, () => next());
  };

test("no tracked cards → no briefing sent", async () => {
  const ada = await person("none");
  await phone(ada);
  await bound(ada, "slack");
  // Work, but none of it followed; and a followed card that ended (cancelled) yesterday.
  await card(ada, { tracked: false, title: "随口问一句" });
  await card(ada, {
    status: "cancelled",
    acceptedAt: at(MONDAY_9, -30 * HOUR),
    updatedAt: at(MONDAY_9, -20 * HOUR),
  });
  const pass = briefingsFor([ada]);

  expect(await pass.buildBriefing(ada.id, "start", MONDAY_9)).toBeNull();
  expect(
    await pass.buildBriefing(ada.id, "end", at(MONDAY_9, 9 * HOUR)),
  ).toBeNull();
  await pass.runBriefings(MONDAY_9);
  await pass.runBriefings(at(MONDAY_9, 9 * HOUR));

  expect(pass.sent).toEqual([]);
  expect(await outbox(ada)).toEqual([]);
  // The day's start was looked at once, and found nothing to say.
  const claims = await runAsTenant(ada.id, () =>
    database
      .select()
      .from(taskBriefings)
      .where(eq(taskBriefings.tenantId, ada.id)),
  );
  expect(claims.map((row) => [row.kind, row.localDay, row.offered])).toEqual(
    expect.arrayContaining([
      ["start", "2026-11-16", 0],
      ["end", "2026-11-16", 0],
    ]),
  );

  // The page says the same: nothing to brief.
  const page = new Hono().route(
    "/api/me/briefing",
    createBriefingRoutes(asUser(ada.id), pass, () => MONDAY_9),
  );
  const response = await page.request("/api/me/briefing?kind=start");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "start", briefing: null });
  expect((await page.request("/api/me/briefing?kind=noon")).status).toBe(400);
  expect((await page.request("/api/me/briefing")).status).toBe(400);
});

test("briefing numbers match the board", async () => {
  const bea = await person("board");
  const other = await person("board-other");
  const soon = await card(bea, {
    title: "没报时间",
    acceptedAt: at(MONDAY_9, -1 * HOUR),
  });
  const later = await card(bea, {
    title: "下午交",
    acceptedAt: at(MONDAY_9, -1 * HOUR),
    dueAt: at(MONDAY_9, 3 * HOUR),
    dueReported: true,
  });
  const waiting = await card(bea, { title: "还没接下" });
  const late = await card(bea, {
    title: "核对三家发票",
    acceptedAt: at(MONDAY_9, -5 * HOUR),
    dueAt: at(MONDAY_9, -2 * HOUR),
    overdueAt: at(MONDAY_9, -85 * MINUTE),
    nudges: 2,
  });
  const asking = await card(bea, {
    title: "等你批",
    status: "needs_action",
    acceptedAt: at(MONDAY_9, -1 * HOUR),
    dueAt: at(MONDAY_9, 2 * HOUR),
  });
  const handed = await card(bea, {
    title: "报表",
    status: "awaiting_review",
    acceptedAt: at(MONDAY_9, -3 * HOUR),
  });
  await line(bea, handed, "delivered", at(MONDAY_9, -40 * MINUTE));
  const reviewedToday = await card(bea, { title: "今早验收", status: "done" });
  await line(bea, reviewedToday, "reviewed", at(MONDAY_9, -30 * MINUTE));
  const reviewedYesterday = await card(bea, {
    title: "昨天验收",
    status: "done",
  });
  await line(bea, reviewedYesterday, "reviewed", at(MONDAY_9, -20 * HOUR));
  await card(bea, { tracked: false, title: "不在跟" });
  await card(other, { title: "别人的活" });

  const pass = briefingsFor([bea, other]);
  const briefing = await pass.buildBriefing(bea.id, "start", MONDAY_9);
  if (!briefing) throw new Error("no briefing");

  // The board, as the person reads it.
  const board = createTaskRoutes(database, asUser(bea.id), projector);
  const list = async (query = "") => {
    const response = await runAsTenant(bea.id, () =>
      board.request(`http://openbot.test/${query}`),
    );
    return (
      (await response.json()) as {
        tasks: { id: string; tracked: boolean; status: string }[];
      }
    ).tasks.filter((row) => row.tracked);
  };
  const followed = await list();
  const working = (rows: { status: string }[]) =>
    rows.filter(
      (row) => row.status === "running" || row.status === "needs_action",
    );
  expect(briefing.awaitingReview.length).toBe(
    followed.filter((row) => row.status === "awaiting_review").length,
  );
  expect(briefing.inProgress.length + briefing.overdue.length).toBe(
    working(followed).length,
  );
  expect(briefing.overdue.length).toBe(
    working(await list("?overdue=1")).length,
  );
  expect(briefing.reviewed).toBe(1);

  expect(briefing.awaitingReview).toEqual([
    {
      taskId: handed,
      title: "报表",
      agentName: "小财",
      deliveredAt: at(MONDAY_9, -40 * MINUTE).toISOString(),
    },
  ]);
  // Soonest due first; a card not yet taken on has no due time, and comes last.
  expect(briefing.inProgress).toEqual([
    {
      taskId: soon,
      title: "没报时间",
      agentName: "小财",
      dueAt: at(MONDAY_9, 1 * HOUR).toISOString(),
    },
    {
      taskId: asking,
      title: "等你批",
      agentName: "小财",
      dueAt: at(MONDAY_9, 2 * HOUR).toISOString(),
    },
    {
      taskId: later,
      title: "下午交",
      agentName: "小财",
      dueAt: at(MONDAY_9, 3 * HOUR).toISOString(),
    },
    { taskId: waiting, title: "还没接下", agentName: "小财", dueAt: null },
  ]);
  expect(briefing.overdue).toEqual([
    { taskId: late, title: "核对三家发票", minutes: 120, nudges: 2 },
  ]);
  expect(briefing.deferred).toEqual([]);

  // The page gives the same briefing.
  const page = new Hono().route(
    "/api/me/briefing",
    createBriefingRoutes(asUser(bea.id), pass, () => MONDAY_9),
  );
  const response = await page.request("/api/me/briefing?kind=start");
  expect(await response.json()).toEqual({ kind: "start", briefing });
});

test("start briefing carries reminders deferred overnight", async () => {
  const cai = await person("overnight", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  await phone(cai);
  await bound(cai, "slack");
  // Due Monday 21:00 in Shanghai; at 22:00 it is overdue, outside the person's work hours.
  const taskId = await card(cai, {
    acceptedAt: at(MONDAY_9, 10 * HOUR),
    dueAt: at(MONDAY_9, 12 * HOUR),
    dueReported: true,
  });
  const checker = checkerFor([cai]);
  await checker.check(at(MONDAY_9, 13 * HOUR));
  const heldAt = (await cardRow(cai, taskId)).reminderHeldAt;
  expect(heldAt).not.toBeNull();
  // Nothing was pushed in the night.
  expect(await outbox(cai)).toEqual([]);

  const pass = briefingsFor([cai]);
  const tuesday9 = at(MONDAY_9, 24 * HOUR);
  await pass.runBriefings(tuesday9);
  expect(pass.sent.map((item) => item.kind)).toEqual(["start"]);
  const [start] = pass.sent;
  expect(start?.briefing.deferred).toEqual([
    expect.stringContaining("『核对发票』已逾期"),
  ]);
  const messages = await outbox(cai, "briefing");
  expect(messages.map((row) => row.transport).sort()).toEqual([
    "push",
    "slack",
  ]);
  for (const message of messages) {
    expect(message.text).toContain("开工清点");
    expect(message.text).toContain("作息外攒下 1 条提醒");
    expect(message.text).toContain("『核对发票』已逾期");
  }
  // Carried once: the held reminder is the briefing's now, and the end briefing has none.
  expect((await cardRow(cai, taskId)).reminderHeldAt).toBeNull();
  const evening = await pass.buildBriefing(
    cai.id,
    "end",
    at(tuesday9, 9 * HOUR),
  );
  expect(evening?.deferred).toEqual([]);
  expect(evening?.overdue.map((item) => item.taskId)).toEqual([taskId]);
});

test("at 09:00 a reminder held overnight goes out once: the briefing first, then the checker", async () => {
  const cai = await person("held-briefing-first", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  await phone(cai);
  await bound(cai, "slack");
  // Due Monday 21:00 in Shanghai; at 22:00 it is overdue and the reminder is held for the morning.
  const taskId = await card(cai, {
    acceptedAt: at(MONDAY_9, 10 * HOUR),
    dueAt: at(MONDAY_9, 12 * HOUR),
    dueReported: true,
  });
  const checker = checkerFor([cai]);
  await checker.check(at(MONDAY_9, 13 * HOUR));
  expect((await cardRow(cai, taskId)).reminderHeldAt).not.toBeNull();

  const tuesday9 = at(MONDAY_9, 24 * HOUR);
  const pass = briefingsFor([cai]);
  await pass.runBriefings(tuesday9);
  // Both minute loops at the same moment, and the next few minutes.
  await checker.check(tuesday9);
  await checker.check(at(tuesday9, MINUTE));
  await checker.check(at(tuesday9, 30 * MINUTE));
  await sweep(cai);
  expect(pass.sent.map((item) => item.briefing.deferred)).toEqual([
    [expect.stringContaining("『核对发票』已逾期")],
  ]);
  expect((await outbox(cai, "briefing")).length).toBe(2);
  // Not pushed a second time on its own.
  expect(await outbox(cai, "overdue")).toEqual([]);
  // The briefing told the person: it counts as today's first reminder, and the next is two hours on.
  const told = await cardRow(cai, taskId);
  expect(told.reminderHeldAt).toBeNull();
  expect(told.lastNotifiedAt?.toISOString()).toBe(tuesday9.toISOString());
  expect(told.notifiedOn).toBe("2026-11-17");
  expect(told.notifiedCount).toBe(1);
  const carried = (
    await runAsTenant(cai.id, () =>
      listTaskEvents(database, { tenantId: cai.id, taskId }),
    )
  ).filter((event) => event.kind === "notified");
  expect(carried.map((event) => event.detail.result)).toEqual([
    "deferred",
    "sent",
  ]);
  const [, sentLine] = carried;
  if (!sentLine) throw new Error("no line for the briefing");
  expect(sentLine.detail).toMatchObject({
    kind: "overdue",
    via: "start_briefing",
  });
  expect(
    taskEventSentence(sentLine, { now: tuesday9, timeZone: "Asia/Shanghai" }),
  ).toBe("开工清点里提醒了你");

  await checker.check(at(tuesday9, 2 * HOUR));
  await sweep(cai);
  expect((await outbox(cai, "overdue")).length).toBe(2);
  expect((await cardRow(cai, taskId)).notifiedCount).toBe(2);
});

test("at 09:00 a reminder held overnight goes out once: the checker first, the briefing after", async () => {
  const lin = await person("held-checker-first", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  await phone(lin);
  const taskId = await card(lin, {
    acceptedAt: at(MONDAY_9, 10 * HOUR),
    dueAt: at(MONDAY_9, 12 * HOUR),
    dueReported: true,
  });
  const checker = checkerFor([lin]);
  await checker.check(at(MONDAY_9, 13 * HOUR));

  const tuesday9 = at(MONDAY_9, 24 * HOUR);
  const pass = briefingsFor([lin]);
  // The checker gets there first: the start briefing is about to carry it, so it leaves it.
  await checker.check(tuesday9);
  await pass.runBriefings(at(tuesday9, MINUTE));
  await checker.check(at(tuesday9, MINUTE));
  await checker.check(at(tuesday9, 5 * MINUTE));
  await sweep(lin);
  expect(pass.sent.map((item) => item.briefing.deferred)).toEqual([
    [expect.stringContaining("『核对发票』已逾期")],
  ]);
  expect((await outbox(lin, "briefing")).length).toBe(1);
  expect(await outbox(lin, "overdue")).toEqual([]);
  expect((await cardRow(lin, taskId)).notifiedCount).toBe(1);
});

test("a held reminder the start briefing never carried is pushed once the briefing's hour is over", async () => {
  const mo = await person("held-not-carried", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  await phone(mo);
  const taskId = await card(mo, {
    acceptedAt: at(MONDAY_9, 10 * HOUR),
    dueAt: at(MONDAY_9, 12 * HOUR),
    dueReported: true,
  });
  const checker = checkerFor([mo]);
  await checker.check(at(MONDAY_9, 13 * HOUR));
  const tuesday9 = at(MONDAY_9, 24 * HOUR);
  // No briefing pass ran (the person's briefing loop was down): the checker waits out its hour only.
  await checker.check(tuesday9);
  await checker.check(at(tuesday9, 59 * MINUTE));
  await sweep(mo);
  expect(await outbox(mo, "overdue")).toEqual([]);
  await checker.check(at(tuesday9, HOUR));
  await sweep(mo);
  expect((await outbox(mo, "overdue")).length).toBe(1);
  const pushed = await cardRow(mo, taskId);
  expect(pushed.reminderHeldAt).toBeNull();
  expect(pushed.notifiedCount).toBe(1);
});

test("weekends off by default", async () => {
  const dan = await person("weekday", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const eve = await person("weekend", {
    workHours: { timeZone: "Asia/Shanghai", weekends: true },
  });
  await card(dan);
  await card(eve);
  const pass = briefingsFor([dan, eve]);

  await pass.runBriefings(SATURDAY_9);
  // Only the person who works weekends is briefed on a Saturday.
  expect(pass.sent.map((item) => item.tenantId)).toEqual([eve.id]);
  const weekdayClaims = await runAsTenant(dan.id, () =>
    database
      .select()
      .from(taskBriefings)
      .where(eq(taskBriefings.tenantId, dan.id)),
  );
  expect(weekdayClaims).toEqual([]);

  await pass.runBriefings(MONDAY_9);
  expect(
    pass.sent
      .filter((item) => item.tenantId === dan.id)
      .map((item) => item.kind),
  ).toEqual(["start"]);
  // 18:00 on Monday: the end of the day.
  await pass.runBriefings(at(MONDAY_9, 9 * HOUR));
  expect(
    pass.sent
      .filter((item) => item.tenantId === dan.id)
      .map((item) => item.kind),
  ).toEqual(["start", "end"]);
});

test("each briefing is sent once per local day even across restarts", async () => {
  const fay = await person("once", {
    workHours: { timeZone: "America/New_York" },
  });
  await phone(fay);
  await card(fay, { acceptedAt: at(MONDAY_9, -2 * HOUR) });
  // 09:00 on Monday in New York.
  const nine = new Date("2026-11-16T14:00:00.000Z");

  // Two replicas at once, then one after a restart: one briefing.
  const first = briefingsFor([fay]);
  const second = briefingsFor([fay]);
  await Promise.all([first.runBriefings(nine), second.runBriefings(nine)]);
  const restarted = briefingsFor([fay]);
  await restarted.runBriefings(at(nine, 5 * MINUTE));
  await restarted.runBriefings(at(nine, 30 * MINUTE));
  const sends = () =>
    [...first.sent, ...second.sent, ...restarted.sent].filter(
      (item) => item.kind === "start",
    ).length;
  expect(sends()).toBe(1);
  expect((await outbox(fay, "briefing")).length).toBe(1);

  // Still inside the hour after the start: nothing more.
  await briefingsFor([fay]).runBriefings(new Date("2026-11-16T14:59:00.000Z"));
  expect((await outbox(fay, "briefing")).length).toBe(1);

  // The clock is the person's own: 09:00 Tuesday in Shanghai is 20:00 Monday in New York.
  const shanghaiMorning = briefingsFor([fay]);
  await shanghaiMorning.runBriefings(new Date("2026-11-17T01:00:00.000Z"));
  expect(shanghaiMorning.sent).toEqual([]);

  // Past the hour after the start, a briefing never sent that day is not sent late.
  const late = briefingsFor([fay]);
  await late.runBriefings(new Date("2026-11-17T15:30:00.000Z"));
  expect(late.sent).toEqual([]);

  // Another morning in New York (Wednesday), a new one.
  const wednesday = briefingsFor([fay]);
  await wednesday.runBriefings(new Date("2026-11-18T14:00:00.000Z"));
  expect(wednesday.sent.map((item) => item.kind)).toEqual(["start"]);
  expect((await outbox(fay, "briefing")).length).toBe(2);
  const claims = await runAsTenant(fay.id, () =>
    database
      .select()
      .from(taskBriefings)
      .where(eq(taskBriefings.tenantId, fay.id)),
  );
  expect(
    claims.map((row) => `${row.kind}:${row.localDay}:${row.offered}`).sort(),
  ).toEqual(["start:2026-11-16:1", "start:2026-11-18:1"]);
});

test("push for briefing deep-links to /briefing and overdue to /tasks/:id", async () => {
  const gus = await person("push", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const device = await phone(gus);
  const taskId = await card(gus, {
    acceptedAt: at(MONDAY_9, -3 * HOUR),
    dueAt: at(MONDAY_9, -1 * HOUR),
  });
  pushSends.length = 0;

  await briefingsFor([gus]).runBriefings(MONDAY_9);
  await sweep(gus);
  const token = `ExponentPushToken[${device}]`;
  const briefingPush = pushSends.find(
    (push) => push.to === token && push.data.kind === "briefing",
  );
  expect(briefingPush).toMatchObject({
    title: "开工清点",
    data: { kind: "briefing", url: "xiongbao://briefing" },
  });

  const result = await runAsTenant(gus.id, () =>
    notices.notify(
      gus.id,
      {
        kind: "overdue",
        taskId,
        text: "『核对发票』已逾期 1 小时（小财，催过 1 次）",
      },
      at(MONDAY_9, 1 * HOUR),
    ),
  );
  expect(result).toBe("sent");
  await sweep(gus);
  const overduePush = pushSends.find(
    (push) => push.to === token && push.data.kind === "overdue",
  );
  expect(overduePush).toMatchObject({
    title: "逾期提醒",
    body: "『核对发票』已逾期 1 小时（小财，催过 1 次）",
    data: { kind: "overdue", taskId, url: `xiongbao://tasks/${taskId}` },
  });

  // Outside the person's work hours the way out holds it, whatever the caller thought.
  const night = await runAsTenant(gus.id, () =>
    notices.notify(
      gus.id,
      { kind: "overdue", taskId, text: "『核对发票』已逾期" },
      at(MONDAY_9, 14 * HOUR),
    ),
  );
  expect(night).toBe("deferred");
  expect((await outbox(gus, "overdue")).length).toBe(1);
});

test("overdue also goes to a bound Slack binding and respects the daily cap", async () => {
  const hal = await person("slack", {
    workHours: {
      start: "00:00",
      end: "23:59",
      weekends: true,
      timeZone: "Asia/Shanghai",
    },
  });
  const slack = await bound(hal, "slack");
  // Due Monday 10:00 in Shanghai.
  const due = at(MONDAY_9, 1 * HOUR);
  const taskId = await card(hal, {
    acceptedAt: at(due, -2 * HOUR),
    dueAt: due,
    dueReported: true,
  });
  const checker = checkerFor([hal]);
  chatSends.length = 0;
  const slackRows = async () =>
    (await outbox(hal, "overdue")).filter((row) => row.transport === "slack");

  // Overdue at +35 minutes, then a reminder every two hours: three on Monday, and no fourth.
  for (const after of [35, 155, 275, 395, 515])
    await checker.check(at(due, after * MINUTE));
  expect((await slackRows()).length).toBe(3);
  expect((await cardRow(hal, taskId)).notifiedCount).toBe(3);

  await sweep(hal);
  const said = chatSends.filter((send) => send.address === slack.address);
  expect(said.length).toBe(3);
  for (const send of said) {
    expect(send.transport).toBe("slack");
    expect(send.text).toContain("逾期提醒");
    expect(send.text).toContain("『核对发票』已逾期");
  }
  for (const row of await slackRows()) expect(row.requestId).toBe(taskId);

  // Tuesday 00:40 in Shanghai is a new day: the count starts again.
  await checker.check(new Date("2026-11-16T16:40:00.000Z"));
  expect((await slackRows()).length).toBe(4);
});

test("timeZone is written on first save from the browser value", async () => {
  const ivy = await person("zone");
  const jo = await person("zone-both");
  const store = createUserPreferencesStore(database);
  const appFor = (userId: string) =>
    new Hono().route(
      "/api/settings/preferences",
      userPreferencesRoutes(asUser(userId), store),
    );
  const save = async (userId: string, body: unknown) => {
    const response = await appFor(userId).request("/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        preferences?: { workHours: Record<string, unknown> };
      },
    };
  };
  const hoursOf = async (userId: string) =>
    (
      (await (
        await appFor(userId).request("/api/settings/preferences")
      ).json()) as { preferences: { workHours: Record<string, unknown> } }
    ).preferences.workHours;

  // Nothing saved: the defaults, on the product's zone.
  expect(await hoursOf(ivy.id)).toEqual({
    start: "09:00",
    end: "18:00",
    timeZone: "Asia/Shanghai",
    weekends: false,
  });

  // The browser's zone, on the first save.
  const first = await save(ivy.id, { browserTimeZone: "America/New_York" });
  expect(first.status).toBe(200);
  expect(first.body.preferences?.workHours).toEqual({
    start: "09:00",
    end: "18:00",
    timeZone: "America/New_York",
    weekends: false,
  });
  expect(await readWorkHours(database, ivy.id)).toEqual({
    start: "09:00",
    end: "18:00",
    timeZone: "America/New_York",
    weekends: false,
  });

  // Never over one already saved: a laptop set to London does not move it.
  await save(ivy.id, { browserTimeZone: "Europe/London" });
  expect((await hoursOf(ivy.id)).timeZone).toBe("America/New_York");

  // A part of the work hours keeps the rest; choosing a zone replaces it.
  await save(ivy.id, { workHours: { start: "10:00" } });
  expect(await hoursOf(ivy.id)).toEqual({
    start: "10:00",
    end: "18:00",
    timeZone: "America/New_York",
    weekends: false,
  });
  await save(ivy.id, { workHours: { timeZone: "Europe/London" } });
  expect((await hoursOf(ivy.id)).timeZone).toBe("Europe/London");

  // A first save that also names other work hours writes the browser's zone with them.
  await save(jo.id, {
    workHours: { weekends: true },
    browserTimeZone: "Asia/Tokyo",
  });
  expect(await hoursOf(jo.id)).toEqual({
    start: "09:00",
    end: "18:00",
    timeZone: "Asia/Tokyo",
    weekends: true,
  });

  // What is not a zone or a clock is refused, and nothing is written.
  for (const body of [
    { browserTimeZone: "Mars/Olympus_Mons" },
    { browserTimeZone: "+05:00" },
    { workHours: { start: "25:00" } },
    { workHours: { end: "9am" } },
    // No "24:00", and the start before the end, counting what is saved (start 10:00).
    { workHours: { end: "24:00" } },
    { workHours: { end: "10:00" } },
    { workHours: { start: "18:00", end: "09:00" } },
    { workHours: {} },
    { workHours: { timeZone: "UTC", lunch: "12:00" } },
  ])
    expect((await save(ivy.id, body)).status).toBe(400);
  expect(await hoursOf(ivy.id)).toEqual({
    start: "10:00",
    end: "18:00",
    timeZone: "Europe/London",
    weekends: false,
  });
  // A row that holds a day the other way round (written around the check) reads as the default day.
  await runAsTenant(ivy.id, () =>
    database
      .update(users)
      .set({
        preferences: {
          workHours: { start: "20:00", end: "08:00", timeZone: "UTC" },
        },
      })
      .where(eq(users.id, ivy.id)),
  );
  expect(await readWorkHours(database, ivy.id)).toEqual({
    start: "09:00",
    end: "18:00",
    timeZone: "UTC",
    weekends: false,
  });
});

test("a briefing that could not be sent is tried again within the hour, and goes out once", async () => {
  const kim = await person("retry", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  await phone(kim);
  await bound(kim, "slack");
  await card(kim, { acceptedAt: at(MONDAY_9, -1 * HOUR) });
  let failures = 1;
  const tries: number[] = [];
  const briefings = createBriefings({
    database,
    workHours: savedWorkHours(database),
    agentName: async () => "小财",
    send: async (tenantId, kind, briefing, now) => {
      tries.push(now.getTime());
      // The first try writes its push and its Slack message and then fails, as a dropped connection would.
      const offered = await notices.sendBriefing(tenantId, kind, briefing, now);
      if (failures-- > 0) throw new Error("connection lost");
      return offered;
    },
    onlyTenants: [kim.id],
  });

  await briefings.runBriefings(MONDAY_9);
  // Not sent: the claim is let go.
  const claims = () =>
    runAsTenant(kim.id, () =>
      database
        .select()
        .from(taskBriefings)
        .where(eq(taskBriefings.tenantId, kim.id)),
    );
  expect(await claims()).toEqual([]);

  // The next minute tries again; what went out before the failure is not offered twice.
  await briefings.runBriefings(at(MONDAY_9, 1 * MINUTE));
  await briefings.runBriefings(at(MONDAY_9, 2 * MINUTE));
  expect(tries.length).toBe(2);
  expect(
    (await outbox(kim, "briefing")).map((row) => row.transport).sort(),
  ).toEqual(["push", "slack"]);
  // Both places were reached, by the first try; the retry wrote nothing new and failed at nothing.
  expect((await claims()).map((row) => row.offered)).toEqual([2]);
});

test("two people on the same platform each get their own briefing that day", async () => {
  const nia = await person("slack-one", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const oto = await person("slack-two", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  for (const who of [nia, oto]) {
    await bound(who, "slack");
    await bound(who, "sms");
    await card(who, { acceptedAt: at(MONDAY_9, -1 * HOUR) });
  }
  const pass = briefingsFor([nia, oto]);
  await pass.runBriefings(MONDAY_9);
  expect(pass.sent.map((item) => item.tenantId).sort()).toEqual(
    [nia.id, oto.id].sort(),
  );
  for (const who of [nia, oto]) {
    const rows = await outbox(who, "briefing");
    expect(rows.map((row) => row.transport).sort()).toEqual(["slack", "sms"]);
    const claims = await runAsTenant(who.id, () =>
      database
        .select()
        .from(taskBriefings)
        .where(eq(taskBriefings.tenantId, who.id)),
    );
    expect(claims.map((row) => row.offered)).toEqual([2]);
  }
  chatSends.length = 0;
  await sweep(nia, oto);
  for (const who of [nia, oto])
    expect(
      chatSends.filter(
        (send) =>
          send.transport === "slack" &&
          send.address === `slack-address-${who.id}`,
      ).length,
    ).toBe(1);

  // Offering the same briefing again (a retry) reaches the same places, writing nothing new.
  const again = {
    ownerUserId: nia.id,
    kind: "briefing" as const,
    id: "start:2026-11-16",
    title: "开工清点",
    body: "还在做 1 件",
    scopes: [],
  };
  expect(await runAsTenant(nia.id, () => router.notifyPerson(again))).toEqual({
    queued: 0,
    already: 2,
  });
  expect((await outbox(nia, "briefing")).length).toBe(2);
});

test("a reminder that reached nobody in work hours is held for the next start briefing, uncounted", async () => {
  // Nothing to reach them on: no phone, no chat account.
  const lou = await person("nobody", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const due = at(MONDAY_9, 1 * HOUR);
  const taskId = await card(lou, {
    acceptedAt: at(due, -2 * HOUR),
    dueAt: due,
    dueReported: true,
  });
  await checkerFor([lou]).check(at(due, 35 * MINUTE));
  const row = await cardRow(lou, taskId);
  expect(row.overdueAt).not.toBeNull();
  // Not counted against the day's three, and kept for the briefing.
  expect(row.notifiedCount).toBe(0);
  expect(row.reminderHeldAt).not.toBeNull();
  expect(await outbox(lou)).toEqual([]);

  const pass = briefingsFor([lou]);
  await pass.runBriefings(at(MONDAY_9, 24 * HOUR));
  expect(pass.sent.map((item) => item.briefing.deferred)).toEqual([
    [expect.stringContaining("『核对发票』已逾期")],
  ]);
});

test("a number that replied STOP is not a place the person was told", async () => {
  const max = await person("stopped", {
    workHours: { timeZone: "Asia/Shanghai" },
  });
  const sms = await bound(max, "sms");
  await runAsTenant(max.id, () =>
    database
      .update(deliveryBindings)
      .set({ optedOutAt: new Date() })
      .where(eq(deliveryBindings.id, sms.id)),
  );
  const taskId = await card(max, {
    acceptedAt: at(MONDAY_9, -3 * HOUR),
    dueAt: at(MONDAY_9, -1 * HOUR),
  });
  const result = await runAsTenant(max.id, () =>
    notices.notify(
      max.id,
      {
        kind: "overdue",
        taskId,
        text: "『核对发票』已逾期 1 小时（小财，催过 0 次）",
      },
      at(MONDAY_9, 1 * HOUR),
    ),
  );
  // Nobody was told, so the reminder waits for the start briefing.
  expect(result).toBe("deferred");
  expect(await outbox(max)).toEqual([]);
});

afterAll(async () => {
  for (const id of people)
    await runAsTenant(id, async () => {
      const queued = await database
        .select({ id: deliveryOutbox.id })
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.ownerUserId, id));
      if (queued.length)
        await database.delete(workItems).where(
          and(
            eq(workItems.tenantId, id),
            inArray(
              workItems.key,
              queued.map((row) => row.id),
            ),
          ),
        );
      await database
        .delete(deliveryOutbox)
        .where(eq(deliveryOutbox.ownerUserId, id));
      await database
        .delete(deliveryBindings)
        .where(eq(deliveryBindings.ownerUserId, id));
      await database.delete(pushDevices).where(eq(pushDevices.ownerUserId, id));
      await database
        .delete(taskBriefings)
        .where(eq(taskBriefings.tenantId, id));
      await database.delete(tasks).where(eq(tasks.tenantId, id));
    });
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", async () => {
    await database
      .delete(channels)
      .where(inArray(channels.id, [...conversations.keys()]));
    await database.delete(agents).where(
      inArray(
        agents.id,
        [...conversations.values()].map((known) => known.agentId),
      ),
    );
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});
