import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agentProfiles } from "../src/db/schema/coworker";
import { boardCards } from "../src/db/schema/board-cards";
import { agents, users } from "../src/db/schema/core";
import { tasks } from "../src/db/schema/tasks";
import { createBoardCards, maxParallelCards } from "../src/tasks/claim";
import { createTaskRoutes } from "../src/tasks/routes";
import { createTaskProjector } from "../src/tasks/projector";
import { Hono } from "hono";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 看板自主认领（Review Focus 4）：两个员工同时领，只有一个领到同一张卡。用真库，因为这件事靠的是
 * `for update skip locked` 和事务锁，假的存储答不了。
 */
const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `claim-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const role = `${prefix}-前端`;
const asOwner = <T>(work: () => T): T => runAsTenant(owner, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
const agentIds = ["a", "b", "c"].map((name) => `${prefix}-${name}`);
const [alice, bob, carol] = agentIds as [string, string, string];
let cap = 2;
const store = createBoardCards(db, { maxParallel: () => cap });

async function profile(tenant: string, id: string, title: string) {
  await runAsTenant(tenant, async () => {
    await db
      .insert(agents)
      .values({ id, name: id, type: "built_in", configuration: {} });
    await db.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: tenant,
      title,
      roleDescription: "",
      avatarSeed: id,
      visibility: "private",
    });
  });
}

beforeAll(async () => {
  for (const id of [owner, other])
    await runAsTenant(id, () =>
      db.insert(users).values({ id, email: `${id}@example.test` }),
    );
  await profile(owner, alice, role);
  await profile(owner, bob, role);
  await profile(owner, carol, `${prefix}-后端`);
});
afterAll(async () => {
  await asPlatform(async () => {
    await db
      .delete(boardCards)
      .where(inArray(boardCards.ownerUserId, [owner, other]));
    await db.delete(tasks).where(inArray(tasks.tenantId, [owner, other]));
    await db.delete(users).where(inArray(users.id, [owner, other]));
    await db.delete(agents).where(inArray(agents.id, agentIds));
  });
  await db.$client.end({ timeout: 5 });
});

const reset = () =>
  asPlatform(async () => {
    await db
      .delete(boardCards)
      .where(inArray(boardCards.ownerUserId, [owner, other]));
    await db.delete(tasks).where(inArray(tasks.tenantId, [owner, other]));
  });
const put = (
  title: string,
  extra: { priority?: number; urgent?: boolean; role?: string } = {},
) =>
  asOwner(() =>
    store.create({
      title,
      role: extra.role ?? role,
      createdBy: owner,
      ...extra,
    }),
  );

describe("原子认领", () => {
  test("两个员工同时领同一张卡：只有一个领到（重复多轮）", async () => {
    for (let round = 0; round < 25; round += 1) {
      await reset();
      const card = await put(`卡 ${round}`);
      const [first, second] = await Promise.all([
        asOwner(() => store.claimNextCard(alice)),
        asOwner(() => store.claimNextCard(bob)),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const [row] = await asOwner(() =>
        db.select().from(boardCards).where(eq(boardCards.id, card.id)),
      );
      expect(row?.status).toBe("claimed");
      expect([alice, bob]).toContain(row?.claimedBy ?? "");
    }
  });

  test("两张卡两个员工同时领：各领一张，不重复", async () => {
    await reset();
    await put("甲");
    await put("乙");
    const [first, second] = await Promise.all([
      asOwner(() => store.claimNextCard(alice)),
      asOwner(() => store.claimNextCard(bob)),
    ]);
    expect(first && second).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });

  test("同一位员工同时来领多次，并行上限照样守住", async () => {
    await reset();
    cap = 1;
    await put("一");
    await put("二");
    await put("三");
    const results = await Promise.all(
      [0, 1, 2].map(() => asOwner(() => store.claimNextCard(alice))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    cap = 2;
  });
});

describe("挑哪一张、能不能领", () => {
  test("先看优先级，同级先放进来的先领", async () => {
    await reset();
    const low = await put("低", { priority: 0 });
    const high = await put("高", { priority: 5 });
    const later = await put("同级晚到", { priority: 0 });
    const order = [
      (await asOwner(() => store.claimNextCard(alice)))?.id,
      (await asOwner(() => store.claimNextCard(bob)))?.id,
    ];
    cap = 5;
    order.push((await asOwner(() => store.claimNextCard(alice)))?.id);
    cap = 2;
    expect(order).toEqual([high.id, low.id, later.id]);
  });

  test("只领派给自己岗位的卡，别的岗位、别人名下的卡不碰", async () => {
    await reset();
    await put("后端的活", { role: `${prefix}-后端` });
    await runAsTenant(other, () =>
      store.create({ title: "别人的卡", role, createdBy: other }),
    );
    expect(await asOwner(() => store.claimNextCard(alice))).toBeNull();
    expect((await asOwner(() => store.claimNextCard(carol)))?.title).toBe(
      "后端的活",
    );
  });

  test("在做的已到上限就不领；交出去等验收的不占名额", async () => {
    await reset();
    cap = 2;
    for (const title of ["一", "二", "三"]) await put(title);
    const first = await asOwner(() => store.claimNextCard(alice));
    const second = await asOwner(() => store.claimNextCard(alice));
    expect(first && second).toBeTruthy();
    expect(await asOwner(() => store.claimNextCard(alice))).toBeNull();
    // 第一张的看板卡交出去等验收了：腾出一个名额。
    for (const [card, status] of [
      [first, "awaiting_review"],
      [second, "running"],
    ] as const) {
      const [task] = await asOwner(() =>
        db
          .insert(tasks)
          .values({ title: card?.title ?? "", source: "routine", status })
          .returning({ id: tasks.id }),
      );
      await asOwner(() => store.markStarted(card?.id ?? "", task?.id ?? ""));
    }
    expect((await asOwner(() => store.claimNextCard(alice)))?.title).toBe("三");
  });

  test("安静时段里只领紧急的卡", async () => {
    await reset();
    await put("不急");
    expect(
      await asOwner(() => store.claimNextCard(alice, { onlyUrgent: true })),
    ).toBeNull();
    await put("急", { urgent: true });
    expect(
      (await asOwner(() => store.claimNextCard(alice, { onlyUrgent: true })))
        ?.title,
    ).toBe("急");
  });

  test("安静时段里有更高优先级的普通卡，领到的仍是紧急卡", async () => {
    await reset();
    await put("普通但优先", { priority: 10 });
    const urgent = await put("急", { priority: 0, urgent: true });
    const got = await asOwner(() => store.claimNextCard(alice, { onlyUrgent: true }));
    expect(got?.id).toBe(urgent.id);
  });

  test("别人发布给你的团队员工：头衔相同、开着心跳，也领不到你的卡，也不被点名", async () => {
    await reset();
    const teamBot = `${prefix}-team`;
    await asPlatform(async () => {
      await db
        .insert(agents)
        .values({ id: teamBot, tenantId: "team", name: teamBot, type: "built_in", configuration: { heartbeat: { enabled: true } } });
      await db.insert(agentProfiles).values({
        agentId: teamBot,
        tenantId: "team",
        ownerUserId: other,
        title: role,
        roleDescription: "",
        avatarSeed: teamBot,
        visibility: "public",
      });
    });
    agentIds.push(teamBot);
    await put("我的卡");
    expect(await asOwner(() => store.claimNextCard(teamBot))).toBeNull();
    expect(await asOwner(() => store.heartbeatEmployees(role))).not.toContain(teamBot);
  });

  test("没有岗位的员工领不到；领了没开成卡的可以放回去", async () => {
    await reset();
    await put("活");
    expect(
      await asOwner(() => store.claimNextCard(`${prefix}-ghost`)),
    ).toBeNull();
    const claimed = await asOwner(() => store.claimNextCard(alice));
    await asOwner(() => store.release(claimed?.id ?? ""));
    expect((await asOwner(() => store.claimNextCard(bob)))?.title).toBe("活");
  });

  test("心跳开着的同岗位员工才会被点名", async () => {
    await asOwner(() =>
      db
        .update(agents)
        .set({ configuration: { heartbeat: { enabled: true } } })
        .where(eq(agents.id, bob)),
    );
    expect(await asOwner(() => store.heartbeatEmployees(role))).toEqual([bob]);
  });

  test("并行上限：默认 2，XIONGBAO_MAX_PARALLEL_CARDS 改，坏值回默认", () => {
    expect(maxParallelCards({})).toBe(2);
    expect(maxParallelCards({ XIONGBAO_MAX_PARALLEL_CARDS: "4" })).toBe(4);
    for (const bad of ["0", "-1", "x", "2.5", "999"])
      expect(maxParallelCards({ XIONGBAO_MAX_PARALLEL_CARDS: bad })).toBe(2);
  });
});

describe("看板卡上的「员工已认领」", () => {
  test("GET /api/tasks 的每张卡带 selfClaimed：员工自己领的是 true，别的是 false", async () => {
    await reset();
    await put("自己领的");
    const claimed = await asOwner(() => store.claimNextCard(alice));
    const [mine] = await asOwner(() =>
      db
        .insert(tasks)
        .values({
          title: "自己领的",
          source: "routine",
          executorAgentId: alice,
        })
        .returning({ id: tasks.id }),
    );
    const [plain] = await asOwner(() =>
      db
        .insert(tasks)
        .values({ title: "人派的", source: "chat", executorAgentId: alice })
        .returning({ id: tasks.id }),
    );
    await asOwner(() => store.markStarted(claimed?.id ?? "", mine?.id ?? ""));
    const routes = createTaskRoutes(
      db,
      async (context, next) => {
        context.set("actor", {
          id: owner,
          email: `${owner}@example.test`,
          role: "user",
        });
        await next();
      },
      createTaskProjector(db),
    );
    const response = await asOwner(() =>
      new Hono().route("/api/tasks", routes).request("/api/tasks"),
    );
    const body = (await response.json()) as {
      tasks: { id: string; selfClaimed: boolean }[];
    };
    expect(body.tasks.find((task) => task.id === mine?.id)?.selfClaimed).toBe(
      true,
    );
    expect(body.tasks.find((task) => task.id === plain?.id)?.selfClaimed).toBe(
      false,
    );
  });
});
