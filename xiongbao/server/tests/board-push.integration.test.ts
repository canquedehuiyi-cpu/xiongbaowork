import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { tasks } from "../src/db/schema/tasks";
import { createBoardPush, MAX_CARDS_PER_PUSH } from "../src/tasks/board-push";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 看板推送的鉴权与租户隔离。用真库和真的 LISTEN：能不能看见一张卡，靠的是租户帧里的行级安全，
 * 假的存储答不了。
 */
const databaseUrl = testDatabaseUrl();
const db = createDatabase(databaseUrl, TEST_POOL);
const prefix = `push-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const dana = `${prefix}-dana`;
const SECRET_TITLE = `${prefix}-密级标题-不许出现在推送里`;
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);

type Wire = {
  type?: string;
  delta?: { op: string; path: string; value?: unknown }[];
};

async function until(done: () => boolean, ms = 4_000) {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop)
    await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A hub on its own LISTEN connection, with one open page per person. */
async function pages() {
  const hub = createChannelEventHub();
  const inbox = {
    alice: [] as Wire[],
    bob: [] as Wire[],
    dana: [] as Wire[],
  };
  hub.register(alice, (raw) => inbox.alice.push(JSON.parse(raw)));
  hub.register(bob, (raw) => inbox.bob.push(JSON.parse(raw)));
  hub.register(dana, (raw) => inbox.dana.push(JSON.parse(raw)));
  const listener = await startChannelActivityListener(databaseUrl, hub);
  return { inbox, stop: () => listener.stop() };
}

async function card(owner: string, status: "running" | "done" = "running") {
  const [row] = await runAsTenant(owner, () =>
    db
      .insert(tasks)
      .values({ title: SECRET_TITLE, source: "routine", status })
      .returning({ id: tasks.id }),
  );
  return (row as { id: string }).id;
}

const setStatus = (id: string, status: string) =>
  asPlatform(() =>
    db.execute(
      sql`update tasks set status = ${status}::task_status, updated_at = now() where id = ${id}`,
    ),
  );

beforeAll(async () => {
  for (const id of [alice, bob, dana])
    await runAsTenant(id, () =>
      db.insert(users).values({ id, email: `${id}@example.test` }),
    );
});
afterAll(async () => {
  await asPlatform(async () => {
    await db.delete(tasks).where(inArray(tasks.tenantId, [alice, bob, dana]));
    await db.delete(users).where(inArray(users.id, [alice, bob, dana]));
  });
  await db.$client.end({ timeout: 5 });
});

describe("看板推送", () => {
  test("本人的卡状态变了，本人收到只含卡片 id 与状态的 STATE_DELTA，别人什么也收不到", async () => {
    const id = await card(alice);
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await push.announce(alice);
      await setStatus(id, "needs_action");
      await push.announce(alice);
      await until(() => open.inbox.alice.length >= 2);

      const last = open.inbox.alice.at(-1);
      expect(last).toEqual({
        type: "STATE_DELTA",
        delta: [
          { op: "replace", path: `/tasks/${id}/status`, value: "needs_action" },
        ],
      });
      // 没有卡片正文，也没有任何多余的字段。
      expect(JSON.stringify(open.inbox.alice)).not.toContain(SECRET_TITLE);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(open.inbox.bob).toEqual([]);
    } finally {
      await open.stop();
    }
  });

  test("别人的卡变了，只推给它的主人：鲍勃的变化不会到爱丽丝那里", async () => {
    const id = await card(bob);
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await setStatus(id, "done");
      // 用爱丽丝的名义去推：她名下没有这张卡，读出来是空的，所以什么也不发。
      await push.announce(alice);
      await push.announce(bob);
      await until(() => open.inbox.bob.length >= 1);

      expect(JSON.stringify(open.inbox.alice)).not.toContain(id);
      expect(JSON.stringify(open.inbox.bob)).toContain(id);
    } finally {
      await open.stop();
    }
  });

  test("卡被移出这个人的看板之后，再变化也推不到他", async () => {
    const id = await card(alice);
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await setStatus(id, "needs_action");
      await push.announce(alice);
      await until(() => JSON.stringify(open.inbox.alice).includes(id));
      expect(JSON.stringify(open.inbox.alice)).toContain(id);
      const heard = open.inbox.alice.length;

      // 移给别人：爱丽丝从此看不见这张卡。
      await asPlatform(() =>
        db.execute(
          sql`update tasks set tenant_id = ${bob}, status = 'done'::task_status, updated_at = now() where id = ${id}`,
        ),
      );
      await push.announce(alice);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // 爱丽丝名下别的卡仍可能在重叠窗口里再报一次；移走的这张不能出现在之后的任何一条里。
      expect(JSON.stringify(open.inbox.alice.slice(heard))).not.toContain(id);

      // 新主人那边照常能收到。
      await push.announce(bob);
      await until(() => JSON.stringify(open.inbox.bob).includes(id));
      expect(JSON.stringify(open.inbox.bob)).toContain(id);
    } finally {
      await open.stop();
    }
  });

  test("开关关着：卡变了也什么都不发", async () => {
    const id = await card(alice);
    const off = createBoardPush(db, { enabled: false });
    const open = await pages();
    try {
      await setStatus(id, "done");
      await off.announce(alice);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(open.inbox.alice).toEqual([]);

      // 对照：同一条路径开着就会发，证明上面的空不是因为链路本身坏了。
      await createBoardPush(db, { enabled: true }).announce(alice);
      await until(() => open.inbox.alice.length > 0);
      expect(open.inbox.alice.length).toBeGreaterThan(0);
    } finally {
      await open.stop();
    }
  });

  test("system 租户的卡变了，爱丽丝收不到（行级安全放行 system 行，推送不能跟着放行）", async () => {
    const id = randomUUID();
    await asPlatform(() =>
      db.execute(
        sql`insert into tasks (id, tenant_id, title, source, status) values (${id}, 'system', ${SECRET_TITLE}, 'routine', 'running')`,
      ),
    );
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await setStatus(id, "needs_action");
      await push.announce(alice);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.stringify(open.inbox.alice)).not.toContain(id);
    } finally {
      await open.stop();
      await asPlatform(() => db.delete(tasks).where(eq(tasks.id, id)));
    }
  });

  test("一批同时间戳的卡之后再改一张：先整板失效，再把这一张推出来（水位不卡死）", async () => {
    const ids: string[] = [];
    for (let at = 0; at < MAX_CARDS_PER_PUSH + 1; at += 1)
      ids.push(await card(dana));
    // 一条语句，同一个时间戳。
    await asPlatform(() =>
      db.execute(
        sql`update tasks set updated_at = now() - interval '1 second' where tenant_id = ${dana}`,
      ),
    );
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await push.announce(dana);
      await until(() => open.inbox.dana.length >= 1);
      // 读满一批：只说整板变了，不点名任何一张卡。
      expect(open.inbox.dana[0]).toEqual({
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/tasks", value: null }],
      });

      const later = await card(dana);
      await setStatus(later, "needs_action");
      // 剩下的同时间戳卡也会陆续报出来；推到这一张为止，且次数有限。
      for (let round = 0; round < 3; round += 1) await push.announce(dana);
      await until(() => JSON.stringify(open.inbox.dana).includes(later));
      expect(JSON.stringify(open.inbox.dana)).toContain(later);
    } finally {
      await open.stop();
    }
  });

  test("同一批卡不会被反复读回：第二次什么也不推", async () => {
    // 上一条留下的几十张卡还在回看窗口里，会把这一条也读成满批。
    await asPlatform(() => db.delete(tasks).where(eq(tasks.tenantId, dana)));
    const id = await card(dana);
    await setStatus(id, "needs_action");
    const push = createBoardPush(db, { enabled: true });
    const open = await pages();
    try {
      await push.announce(dana);
      await until(() => JSON.stringify(open.inbox.dana).includes(id));
      const heard = open.inbox.dana.length;
      await push.announce(dana);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.stringify(open.inbox.dana.slice(heard))).not.toContain(id);
    } finally {
      await open.stop();
    }
  });
});
