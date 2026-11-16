import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createRequireUser } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { deliveryBindings } from "../src/db/schema/delivery";
import { createDeliveryRoutes } from "../src/delivery/routes";
import { createDeliveryScopes } from "../src/delivery/scope";
import { createDeliveryStore } from "../src/delivery/store";
import { DeliveryRefusedError } from "../src/delivery/types";
import { createWechatStore } from "../src/delivery/wechat/store";
import type { PeopleStore } from "../src/people/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 解绑微信时清掉这个人的微信投递绑定（计划 2026-11-16-im-channels-wechat Task 10）：
 * `bind` 的持有者检查不看 `enabled`，只禁用的话，别人再绑同一个微信、找同一位员工就会被拒。
 * 走真的路由和真的库，请求在本人帧里跑。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wxub-${randomUUID().slice(0, 8)}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const people = [alice, bob];
const madeAgents: string[] = [];
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const deliveryStore = createDeliveryStore(database);
const wechatStore = createWechatStore(database);
const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const scopes = createDeliveryScopes({
  database,
  people: {
    find: async (id: string) =>
      people.includes(id) ? ({ id, revoked: false } as never) : undefined,
  } as Pick<PeopleStore, "find">,
  actorFor,
  channels: channelStore,
  bots: profileStore,
});

const requireUser = createRequireUser(
  {
    handler: () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-test-user");
        return id ? { user: { id, email: `${id}@example.test` } } : null;
      },
    },
  },
  { rolesForUser: async () => ["user"] },
);
const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/delivery",
  createDeliveryRoutes({
    store: deliveryStore,
    router: { receiveNative: async () => ({}) as never },
    requireUser,
    scopeFor: async () => null,
    listConversations: async () => ({ channels: [], nextCursor: null }),
    history: async () => [],
    wechat: {
      database,
      ilink: {
        getBotQrcode: async () => ({ qrcode: "x", imageContent: null }),
        getQrcodeStatus: async () => ({ status: "wait" as const }),
      },
      store: wechatStore,
      credentials: createCredentialStore(database),
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  }),
);

const saveAccount = (userId: string, name: string) =>
  runAsTenant(userId, () =>
    wechatStore.saveAccount({
      userId,
      ilinkBotId: `${prefix}-bot-${name}@im.bot`,
      ilinkUserId: `${prefix}-wx@im.wechat`,
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialId: null,
    }),
  );

async function seed(userId: string, name: string) {
  await runAsTenant(userId, () =>
    database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test` }),
  );
  const profile = await runAsTenant(userId, () =>
    profileStore.create(
      { id: userId, role: "user" },
      {
        name,
        title: "工程师",
        roleDescription: "简短回答。",
        visibility: "private",
      },
    ),
  );
  madeAgents.push(profile.id);
  const direct = await runAsTenant(userId, async () =>
    channelStore.direct(await actorFor(userId), profile.id),
  );
  const scope = await runAsTenant(userId, () =>
    scopes.scopeFor(userId, direct.id, profile.id),
  );
  if (!scope) throw new Error("no scope");
  return scope;
}

const bindWechat = (scope: Awaited<ReturnType<typeof seed>>, realm: string) =>
  runAsTenant(scope.ownerUserId, () =>
    deliveryStore.bind({
      ...scope,
      transport: "wechat",
      realm,
      identity: `${prefix}-wx@im.wechat#same-bot`,
      address: `${prefix}-wx@im.wechat`,
    }),
  );
const rowsOf = (userId: string, transport: "wechat" | "slack") =>
  runAsTenant("platform", () =>
    database
      .select({ id: deliveryBindings.id })
      .from(deliveryBindings)
      .where(
        and(
          eq(deliveryBindings.ownerUserId, userId),
          eq(deliveryBindings.transport, transport),
        ),
      ),
  );

afterAll(async () => {
  await runAsTenant("platform", async () => {
    const owned = madeAgents.length
      ? await database
          .select({ id: channelAgents.channelId })
          .from(channelAgents)
          .where(inArray(channelAgents.agentId, madeAgents))
      : [];
    await database
      .delete(deliveryBindings)
      .where(inArray(deliveryBindings.ownerUserId, people));
    for (const { id } of owned) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    if (madeAgents.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, madeAgents));
      await database.delete(agents).where(inArray(agents.id, madeAgents));
    }
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

test("A 解绑后，微信绑定行被删掉（Slack 绑定不动），B 绑同一个微信、找同一位员工能成功", async () => {
  const realm = `${prefix}-realm`;
  const aliceScope = await seed(alice, "小熊");
  const bobScope = await seed(bob, "小熊");
  await saveAccount(alice, "alice");
  await bindWechat(aliceScope, realm);
  await runAsTenant(alice, () =>
    deliveryStore.bind({
      ...aliceScope,
      transport: "slack",
      realm: `${prefix}-slack`,
      identity: `${prefix}-U1`,
      address: "C1",
    }),
  );
  // 解绑前，别人绑不了（原来的行为）。
  await expect(bindWechat(bobScope, realm)).rejects.toBeInstanceOf(
    DeliveryRefusedError,
  );

  const response = await app.request("/api/delivery/wechat", {
    method: "DELETE",
    headers: { "x-test-user": alice },
  });
  expect(response.status).toBe(204);

  expect(await rowsOf(alice, "wechat")).toHaveLength(0);
  expect(await rowsOf(alice, "slack")).toHaveLength(1);
  // 再解绑一次也无妨。
  expect(
    (
      await app.request("/api/delivery/wechat", {
        method: "DELETE",
        headers: { "x-test-user": alice },
      })
    ).status,
  ).toBe(204);

  // 微信账号表里同一个微信只能挂一个人：A 解绑后 B 才能存账号。
  await saveAccount(bob, "bob");
  const bound = await bindWechat(bobScope, realm);
  expect(bound.ownerUserId).toBe(bob);
  expect(await rowsOf(bob, "wechat")).toHaveLength(1);
});
