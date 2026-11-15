import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  externalEmployeesAmong,
  externalHirerOf,
} from "../src/agents/acp/external";
import {
  type PresenceDeviceReachable,
  readAgentPresence,
} from "../src/agents/presence";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createGroupRoster } from "../src/channels/group-roster";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  type AcpTurnStatus,
  acpTurns,
  agentProfiles,
  agents,
  botLifecycle,
  channels,
  intelligenceChannelMappings,
  tasks,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 员工此刻（聊天工作台 Task 8）：`GET /api/agents/presence?ids=…` 一次读一批员工的忙 / 闲 / 暂停和正在做的
 * 事，读的是员工详情页那两条读取（暂停行、看板上运行中的任务）同样的事实，看得到谁和员工列表同一套规则。
 * 真库、真的员工存储和路由；每个用例在自己这一批员工上断言，互不依赖先后。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const suite = `presence-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const id of channelIds) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    await database.delete(acpTurns).where(inArray(acpTurns.tenantId, people));
    await database.delete(tasks).where(inArray(tasks.tenantId, people));
    await database
      .delete(botLifecycle)
      .where(inArray(botLifecycle.ownerUserId, people));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Presence Test" }),
  );
  return { id, role: "user" };
}

/** Somebody's own private coworker. */
async function coworker(owner: AgentActor, name: string) {
  const id = `${suite}-agent-${randomUUID()}`;
  agentIds.push(id);
  await runAsTenant(owner.id, async () => {
    await database.insert(agents).values({
      id,
      name,
      type: "built_in",
      configuration: { systemPrompt: "测试。" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner.id,
      title: name,
      roleDescription: "测试员工。",
      avatarSeed: id,
      visibility: "private",
    });
  });
  return id;
}

async function task(
  tenant: string,
  executorAgentId: string,
  title: string,
  status: "running" | "done",
  updatedAt = new Date(),
  channelRef?: string,
) {
  await runAsTenant(tenant, () =>
    database.insert(tasks).values({
      title,
      executorAgentId,
      source: "chat",
      status,
      updatedAt,
      ...(channelRef ? { channelRef } : {}),
    }),
  );
}

async function pause(owner: AgentActor, agentId: string, paused: boolean) {
  await runAsTenant(owner.id, () =>
    database.insert(botLifecycle).values({
      ownerUserId: owner.id,
      agentId,
      pausedAt: paused ? new Date() : null,
    }),
  );
}

/** Hired from a computer: what Task 8 writes for an external employee. */
async function external(owner: AgentActor, name: string, deviceId: string) {
  const id = await coworker(owner, name);
  await runAsTenant("platform", () =>
    database
      .update(agents)
      .set({
        type: "device_acp",
        configuration: { deviceId, harness: "codex", workdirRef: "fld_work" },
      })
      .where(eq(agents.id, id)),
  );
  return id;
}

/** Turns of an external employee in its hirer's tenant, one per status given. */
async function turnsOf(
  tenant: string,
  agentId: string,
  deviceId: string,
  statuses: AcpTurnStatus[],
) {
  await runAsTenant(tenant, () =>
    database.insert(acpTurns).values(
      statuses.map((status) => ({
        agentId,
        threadId: `${suite}-thread`,
        deviceId,
        turnId: `${suite}-turn-${randomUUID()}`,
        status,
        prompt: { content: [{ type: "text", text: "活" }] },
      })),
    ),
  );
}

function routesFor(
  actor: AgentActor,
  deviceReachable?: PresenceDeviceReachable,
) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  return createAgentRoutes(
    profiles,
    guard,
    false,
    undefined,
    new Set<string>(),
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      read: (who, ids) =>
        readAgentPresence(
          database,
          who,
          ids,
          deviceReachable ? { deviceReachable } : {},
        ),
    },
  );
}

type Presence = {
  agentId: string;
  status: "working" | "resting" | "paused" | "offline" | "unknown";
  doing: string | null;
  queued?: number;
};

async function presenceOf(
  actor: AgentActor,
  ids: readonly string[],
  deviceReachable?: PresenceDeviceReachable,
) {
  const response = await routesFor(actor, deviceReachable).request(
    new Request(
      `http://presence.test/presence?ids=${ids.map(encodeURIComponent).join(",")}`,
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Presence[] };
  return [...body.items].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

describe("GET /api/agents/presence", () => {
  test("运行中任务→忙碌并写最近动过的那件；暂停→已暂停；都没有→空闲", async () => {
    const owner = await person();
    const busy = await coworker(owner, "代码熊");
    const paused = await coworker(owner, "暖心医生");
    const idle = await coworker(owner, "小熊会计");
    await task(
      owner.id,
      busy,
      "早一点的任务",
      "running",
      new Date(Date.now() - 60_000),
    );
    await task(owner.id, busy, "跑登录页的测试", "running");
    // 暂停优先：哪怕手上还有一件在跑。
    await task(owner.id, paused, "暂停前开始的任务", "running");
    await pause(owner, paused, true);
    // 做完的任务不算在忙，恢复过（暂停时间为空）的行不算暂停。
    await task(owner.id, idle, "上个月的报销", "done");
    await pause(owner, idle, false);

    expect(await presenceOf(owner, [busy, paused, idle])).toEqual(
      [
        { agentId: busy, status: "working", doing: "跑登录页的测试" },
        { agentId: paused, status: "paused", doing: null },
        { agentId: idle, status: "resting", doing: null },
      ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
  });

  test("看不到的员工、不存在的 id 不返回；别的租户里的任务不算", async () => {
    const owner = await person();
    const stranger = await person();
    const mine = await coworker(owner, "熊大厨");
    const theirs = await coworker(stranger, "别人的员工");
    await task(stranger.id, theirs, "别人的事", "running");
    // 另一个租户里挂在我的员工名下的运行中任务，读我的员工时看不到。
    await task(stranger.id, mine, "不该看到的任务", "running");

    expect(await presenceOf(owner, [mine, theirs, `${suite}-nobody`])).toEqual([
      { agentId: mine, status: "resting", doing: null },
    ]);
  });

  test("暂停只看请求人自己的那一行", async () => {
    const owner = await person();
    const other = await person();
    const agentId = await coworker(owner, "研发熊");
    // 同一位员工，另一个人暂停了它（例如它公开时），不影响请求人看到的状态。
    await runAsTenant(owner.id, () =>
      database
        .update(agentProfiles)
        .set({ visibility: "public" })
        .where(eq(agentProfiles.agentId, agentId)),
    );
    await pause(other, agentId, true);

    expect(await presenceOf(owner, [agentId])).toEqual([
      { agentId, status: "resting", doing: null },
    ]);
  });

  test("没有 ids 时回空列表，「presence」不被当成员工 id", async () => {
    const owner = await person();
    const response = await routesFor(owner).request(
      new Request("http://presence.test/presence"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  test("超过 100 个 id 是 400", async () => {
    const owner = await person();
    const ids = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    const response = await routesFor(owner).request(
      new Request(`http://presence.test/presence?ids=${ids.join(",")}`),
    );
    expect(response.status).toBe(400);
    // 正好 100 个照常回答。
    expect(await presenceOf(owner, ids.slice(0, 100))).toEqual([]);
  });

  test("an external employee whose computer is away is offline with its queued count", async () => {
    const owner = await person();
    const stranger = await person();
    const away = await external(owner, "小码", "laptop");
    const here = await external(owner, "小测", "desktop");
    const builtIn = await coworker(owner, "代码熊");
    // Waiting for the computer: queued, and sent but never acknowledged (spec §3: a turn leaves the
    // queue when the device says it started). Running, awaiting and finished ones are not waiting.
    await turnsOf(owner.id, away, "laptop", [
      "queued",
      "sent",
      "running",
      "awaiting",
      "done",
      "cancelled",
    ]);
    await turnsOf(owner.id, here, "desktop", ["queued"]);
    // Somebody else's tenant is never counted, even under the same employee id.
    await turnsOf(stranger.id, away, "laptop", ["queued", "queued"]);
    // Offline wins over a card still running and over a pause.
    await task(owner.id, away, "推送登录页修复", "running");
    await pause(owner, away, true);
    await task(owner.id, here, "跑测试", "running");
    const asked: { tenantId: string; deviceId: string }[] = [];
    const reachable: PresenceDeviceReachable = async (target) => {
      asked.push(target);
      return target.deviceId === "desktop";
    };

    expect(await presenceOf(owner, [away, here, builtIn], reachable)).toEqual(
      (
        [
          { agentId: away, status: "offline", doing: null, queued: 2 },
          // Reachable: the usual reading, and no count.
          { agentId: here, status: "working", doing: "跑测试" },
          { agentId: builtIn, status: "resting", doing: null },
        ] satisfies Presence[]
      ).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
    // Asked about its hirer's computers only, never about a built-in employee.
    expect(asked.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
      { tenantId: owner.id, deviceId: "desktop" },
      { tenantId: owner.id, deviceId: "laptop" },
    ]);
    // Back online: the pause shows again, and the count goes.
    expect(await presenceOf(owner, [away], async () => true)).toEqual([
      { agentId: away, status: "paused", doing: null },
    ]);
    // A computer check that fails reads as away, not as an error.
    expect(
      await presenceOf(owner, [here], async () => {
        throw new Error("database down");
      }),
    ).toEqual([{ agentId: here, status: "offline", doing: null, queued: 1 }]);
  });

  test("a group member sees someone else's external employee's state, never its queue", async () => {
    const hirer = await person();
    const teammate = await person();
    const outsider = await person();
    const away = await external(hirer, "小码", "laptop");
    const writer = await coworker(teammate, "Writer");
    const reviewer = await coworker(teammate, "Reviewer");
    await turnsOf(hirer.id, away, "laptop", ["queued", "queued", "queued"]);
    await task(hirer.id, away, "推送登录页修复", "running");
    const store = createGroupStore(database, () => threadIdentity.mint());
    const actorFor = async (id: string): Promise<AgentActor> => ({
      id,
      role: "user",
    });
    const groups = createGroupConversations({
      store,
      queue: createWorkQueue(database),
      owner: `${suite}-replica`,
      roster: createGroupRoster({
        actorFor,
        channel: (actor, channelId) => channelStore.get(actor, channelId),
        profile: (actor, agentId) => profiles.get(actor, agentId),
        externalEmployees: (ids) => externalEmployeesAmong(database, ids),
        members: (channelId) => store.members(channelId),
      }),
      runTurn: async () => ({ replyText: "" }),
      caps: { maxDepth: 0, maxPerRun: 0 },
      mayAddress: async () => false,
      auditStore: { insert: async () => undefined },
      createChannel: (ownerUserId, ids, options) =>
        channelStore.create({ id: ownerUserId, role: "user" }, ids, options),
      canUseBot: async (ownerUserId, agentId) =>
        Boolean(await profiles.get(await actorFor(ownerUserId), agentId)),
      externalHirer: (agentId) => externalHirerOf(database, agentId),
    });
    // The teammate's group; the hirer joins and brings the employee in (Task 8).
    const group = await runAsTenant(teammate.id, () =>
      groups.create(teammate.id, { agentIds: [writer, reviewer] }),
    );
    channelIds.push(group.id);
    await runAsTenant(teammate.id, () =>
      groups.addMember(teammate.id, group.id, {
        email: `${hirer.id}@example.test`,
      }),
    );
    await runAsTenant(hirer.id, () =>
      groups.addBots(hirer.id, group.id, [away]),
    );
    let online = false;
    const reachable: PresenceDeviceReachable = async (target) =>
      online && target.tenantId === hirer.id && target.deviceId === "laptop";

    // The hirer: offline, with the count.
    expect(await presenceOf(hirer, [away], reachable)).toEqual([
      { agentId: away, status: "offline", doing: null, queued: 3 },
    ]);
    // A member of a group it is in: offline too, but the count is the hirer's own business.
    expect(await presenceOf(teammate, [away], reachable)).toEqual([
      { agentId: away, status: "offline", doing: null },
    ]);
    // Back online: busy, as its hirer's board says, but what it does in its hirer's own chat is the
    // hirer's business: no title.
    online = true;
    expect(await presenceOf(teammate, [away], reachable)).toEqual([
      { agentId: away, status: "working", doing: null },
    ]);
    // The hirer still sees the title of their own work.
    expect(await presenceOf(hirer, [away], reachable)).toEqual([
      { agentId: away, status: "working", doing: "推送登录页修复" },
    ]);
    // Work of this group: the members see what it is.
    await task(
      hirer.id,
      away,
      "整理群里的发布清单",
      "running",
      new Date(Date.now() - 60_000),
      group.id,
    );
    expect(await presenceOf(teammate, [away], reachable)).toEqual([
      { agentId: away, status: "working", doing: "整理群里的发布清单" },
    ]);
    // Work of another group the teammate is not in stays hidden too.
    await task(
      hirer.id,
      away,
      "别的群里的事",
      "running",
      new Date(),
      "other-group",
    );
    expect(await presenceOf(teammate, [away], reachable)).toEqual([
      { agentId: away, status: "working", doing: "整理群里的发布清单" },
    ]);
    // Nobody outside the group hears of it.
    expect(await presenceOf(outsider, [away], reachable)).toEqual([]);
    // Once its hirer has left the group, neither does the group.
    await runAsTenant(hirer.id, () =>
      groups.removeMember(hirer.id, group.id, hirer.id),
    );
    expect(await presenceOf(teammate, [away], reachable)).toEqual([]);
  });
});
