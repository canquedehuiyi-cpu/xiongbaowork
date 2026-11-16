import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRequireUser } from "../src/auth/guards";
import { createCredentialStore, openCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, users } from "../src/db/schema/core";
import { wechatAccounts, wechatBindAttempts } from "../src/db/schema/wechat";
import { createDeliveryRoutes } from "../src/delivery/routes";
import { createDeliveryStore } from "../src/delivery/store";
import { DeliveryProviderError } from "../src/delivery/types";
import {
  WECHAT_WELCOME_TEXT,
  wechatEnabled,
} from "../src/delivery/wechat/bind";
import type {
  IlinkClient,
  IlinkQrcodeStatus,
} from "../src/delivery/wechat/ilink";
import { createWechatWelcome } from "../src/delivery/wechat/inbound";
import { createWechatStore } from "../src/delivery/wechat/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 扫码绑定与解绑（计划 2026-11-16-im-channels-wechat Task 4），走真的登录中间件、真的路由和真的库：
 * 请求在本人帧里跑，账号行和凭据都记在这个人的租户下。iLink 用假客户端，按二维码回放状态。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const prefix = `wxbind-${randomUUID().slice(0, 8)}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const carol = `${prefix}-carol`;
const dave = `${prefix}-dave`;
const erin = `${prefix}-erin`;
const frank = `${prefix}-frank`;
const gina = `${prefix}-gina`;
const people = [alice, bob, carol, dave, erin, frank, gina];
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
const wechatStore = createWechatStore(database);
const credentialStore = createCredentialStore(database);

type StatusAnswer = Awaited<ReturnType<IlinkClient["getQrcodeStatus"]>>;
/** 假 iLink：每张二维码回放下一个状态；记下问了几次。 */
function fakeIlink() {
  let issued = 0;
  const answers = new Map<string, StatusAnswer[]>();
  const asked: string[] = [];
  const client: Pick<IlinkClient, "getBotQrcode" | "getQrcodeStatus"> = {
    async getBotQrcode() {
      issued += 1;
      return {
        qrcode: `${prefix}-qr-${issued}`,
        imageContent: `https://liteapp.weixin.qq.com/q/${prefix}-${issued}`,
      };
    },
    async getQrcodeStatus(qrcode) {
      asked.push(qrcode);
      const queue = answers.get(qrcode) ?? [];
      const next = queue.shift();
      return next ?? { status: "wait" };
    },
  };
  return {
    client,
    asked,
    answer(qrcode: string, ...queue: StatusAnswer[]) {
      answers.set(qrcode, queue);
    },
  };
}
const status = (value: IlinkQrcodeStatus): StatusAnswer => ({ status: value });
const confirmed = (
  ilinkUserId: string,
  botToken: string,
  baseUrl = "https://ilinkai.weixin.qq.com",
): StatusAnswer => ({
  status: "confirmed",
  session: {
    baseUrl,
    botToken,
    botId: `${prefix}-bot-${ilinkUserId}`,
    userId: ilinkUserId,
  },
});

/** 登录中间件照生产：会话里的人是谁，请求就在谁的帧里跑。测试用请求头说是谁。 */
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

function appWith(
  wechat?: Parameters<typeof createDeliveryRoutes>[0]["wechat"],
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/delivery",
    createDeliveryRoutes({
      store: createDeliveryStore(database),
      router: { receiveNative: async () => ({}) as never },
      requireUser,
      scopeFor: async () => null,
      listConversations: async () => ({ channels: [], nextCursor: null }),
      history: async () => [],
      ...(wechat ? { wechat } : {}),
    }),
  );
  return app;
}

const ilink = fakeIlink();
const app = appWith({
  database,
  ilink: ilink.client,
  store: wechatStore,
  credentials: credentialStore,
  encryptionKey: KEY,
});

const call = (
  target: Hono<{ Variables: AppVariables }>,
  who: string,
  method: string,
  path: string,
) =>
  target.request(`/api/delivery${path}`, {
    method,
    headers: { "x-test-user": who, "content-type": "application/json" },
  });

async function start(who: string, target = app) {
  const response = await call(target, who, "POST", "/wechat/start");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    attemptId: string;
    imageContent: string;
    expiresInMinutes: number;
  };
  const [row] = await asPlatform(() =>
    database
      .select({ qrcode: wechatBindAttempts.qrcode })
      .from(wechatBindAttempts)
      .where(eq(wechatBindAttempts.id, body.attemptId)),
  );
  return { ...body, qrcode: row?.qrcode ?? "" };
}

async function poll(who: string, attemptId: string, target = app) {
  const response = await call(
    target,
    who,
    "GET",
    `/wechat/attempts/${attemptId}`,
  );
  return {
    code: response.status,
    body: (await response.json()) as { status: string; message?: string },
  };
}

async function overview(who: string, target = app) {
  const response = await call(target, who, "GET", "");
  expect(response.status).toBe(200);
  const text = await response.text();
  return {
    text,
    body: JSON.parse(text) as {
      available: Record<string, boolean>;
      wechat: {
        status: string;
        boundAt: string;
        paused: boolean;
        windowOpen: boolean;
        lastInboundAt: string | null;
        pausedUntil: string | null;
      } | null;
    },
  };
}

const liveWechatCredentials = (owner: string) =>
  asPlatform(() =>
    database
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, owner),
          eq(credentials.provider, "wechat"),
        ),
      ),
  );

beforeAll(async () => {
  for (const id of people)
    await runAsTenant(id, () =>
      database.insert(users).values({ id, email: `${id}@example.test` }),
    );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(credentials)
      .where(inArray(credentials.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

test("扫码绑定：wait、scaned 照实回答，确认后存凭据、写账号，总览里只露状态不露任何令牌和 id", async () => {
  const attempt = await start(alice);
  expect(attempt.expiresInMinutes).toBe(10);
  expect(attempt.imageContent).toContain("liteapp.weixin.qq.com");
  const ilinkUser = `${prefix}-ilink-alice`;
  const botToken = `${prefix}-BOT-TOKEN-SECRET`;
  ilink.answer(
    attempt.qrcode,
    status("wait"),
    status("scaned"),
    confirmed(ilinkUser, botToken),
  );

  expect(await poll(alice, attempt.attemptId)).toEqual({
    code: 200,
    body: { status: "wait" },
  });
  expect(await poll(alice, attempt.attemptId)).toEqual({
    code: 200,
    body: { status: "scaned" },
  });
  expect(await poll(alice, attempt.attemptId)).toEqual({
    code: 200,
    body: { status: "bound" },
  });

  // 绑好以后再问，不再去问微信。
  const askedBefore = ilink.asked.length;
  expect((await poll(alice, attempt.attemptId)).body.status).toBe("bound");
  expect(ilink.asked.length).toBe(askedBefore);

  const account = await runAsTenant(alice, () => wechatStore.account(alice));
  expect(account?.status).toBe("bound");
  expect(account?.tenantId).toBe(alice);
  expect(account?.ilinkUserId).toBe(ilinkUser);
  expect(account?.boundAt).toBeInstanceOf(Date);
  const credentialId = account?.credentialId ?? "";
  expect(credentialId).not.toBe("");

  // 令牌封在本人的凭据里，按行绑定加密，元数据里没有令牌。
  const [credential] = await asPlatform(() =>
    database.select().from(credentials).where(eq(credentials.id, credentialId)),
  );
  expect(credential?.kind).toBe("chat");
  expect(credential?.provider).toBe("wechat");
  expect(credential?.tenantId).toBe(alice);
  expect(credential?.revokedAt).toBeNull();
  expect(JSON.stringify(credential?.metadata)).not.toContain(botToken);
  expect(credential?.encryptedValue).not.toContain(botToken);
  expect(
    await openCredential(KEY, {
      tenantId: credential?.tenantId ?? "",
      id: credential?.id ?? "",
      kind: credential?.kind ?? "chat",
      encryptedValue: credential?.encryptedValue ?? "",
    }),
  ).toBe(botToken);

  // 收到过一条入站后，时间窗开着；上下文令牌也不出接口。
  const contextToken = `${prefix}-CONTEXT-TOKEN-SECRET`;
  await runAsTenant(alice, () =>
    wechatStore.markInbound(account?.id ?? "", {
      at: new Date(),
      contextToken,
    }),
  );
  const { text, body } = await overview(alice);
  expect(body.available.wechat).toBe(true);
  expect(body.wechat).toEqual({
    status: "bound",
    boundAt: account?.boundAt?.toISOString() ?? "",
    paused: false,
    windowOpen: true,
    lastInboundAt: expect.any(String),
    pausedUntil: null,
  });
  for (const secret of [
    botToken,
    contextToken,
    ilinkUser,
    account?.ilinkBotId ?? "",
    credentialId,
    account?.id ?? "",
  ])
    expect(text).not.toContain(secret);
});

test("第二个人扫同一个微信得到 taken，不保存；第一个人仍是 bound", async () => {
  const ilinkUser = `${prefix}-ilink-alice`;
  const attempt = await start(bob);
  ilink.answer(attempt.qrcode, confirmed(ilinkUser, `${prefix}-BOB-TOKEN`));

  expect(await poll(bob, attempt.attemptId)).toEqual({
    code: 200,
    body: { status: "taken", message: "这个微信已绑在别的账号上" },
  });
  // 之后再问还是 taken，不再问微信。
  const askedBefore = ilink.asked.length;
  expect((await poll(bob, attempt.attemptId)).body.status).toBe("taken");
  expect(ilink.asked.length).toBe(askedBefore);

  expect((await overview(bob)).body.wechat).toBeNull();
  expect(await runAsTenant(bob, () => wechatStore.account(bob))).toBeNull();
  expect(await liveWechatCredentials(bob)).toEqual([]);
  expect((await overview(alice)).body.wechat?.status).toBe("bound");
});

test("两个人同时绑：查重时还没看见对方，唯一索引拒绝的那个也得到 taken，凭据一并撤回", async () => {
  const ilinkUser = `${prefix}-ilink-alice`;
  // 模拟查重和写入之间对方抢先写入：查重什么都看不见，写入时撞上部分唯一索引。
  const racing = fakeIlink();
  const raceApp = appWith({
    database,
    ilink: racing.client,
    store: { ...wechatStore, accountByIlinkUser: async () => null },
    credentials: credentialStore,
    encryptionKey: KEY,
  });
  const attempt = await start(carol, raceApp);
  racing.answer(attempt.qrcode, confirmed(ilinkUser, `${prefix}-CAROL-TOKEN`));

  expect(await poll(carol, attempt.attemptId, raceApp)).toEqual({
    code: 200,
    body: { status: "taken", message: "这个微信已绑在别的账号上" },
  });
  expect(await runAsTenant(carol, () => wechatStore.account(carol))).toBeNull();
  expect(await liveWechatCredentials(carol)).toEqual([]);
  expect((await overview(alice)).body.wechat?.status).toBe("bound");
});

test("别人的 attemptId 一律 404", async () => {
  const attempt = await start(alice);
  const askedBefore = ilink.asked.length;
  const answer = await poll(bob, attempt.attemptId);
  expect(answer.code).toBe(404);
  expect(ilink.asked.length).toBe(askedBefore);
  expect((await poll(bob, randomUUID())).code).toBe(404);
});

test("过期：微信说过期照实回答；本地已过期的不再去问微信", async () => {
  const fromWechat = await start(dave);
  ilink.answer(fromWechat.qrcode, status("expired"));
  expect(await poll(dave, fromWechat.attemptId)).toEqual({
    code: 200,
    body: { status: "expired", message: "二维码已过期，请换一张" },
  });

  const stale = await start(dave);
  await asPlatform(() =>
    database
      .update(wechatBindAttempts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(wechatBindAttempts.id, stale.attemptId)),
  );
  const askedBefore = ilink.asked.length;
  expect(await poll(dave, stale.attemptId)).toEqual({
    code: 200,
    body: { status: "expired", message: "二维码已过期，请换一张" },
  });
  expect(ilink.asked.length).toBe(askedBefore);
});

test("绑定返回的地址不是微信自己的 https 主机：failed，不保存", async () => {
  const attempt = await start(dave);
  ilink.answer(
    attempt.qrcode,
    confirmed(
      `${prefix}-ilink-dave`,
      `${prefix}-DAVE-TOKEN`,
      "https://weixin.qq.com.evil.example",
    ),
  );
  const answer = await poll(dave, attempt.attemptId);
  expect(answer.code).toBe(200);
  expect(answer.body.status).toBe("failed");
  expect(answer.body.message).toBeTruthy();
  expect(await runAsTenant(dave, () => wechatStore.account(dave))).toBeNull();
  expect(await liveWechatCredentials(dave)).toEqual([]);
});

test("解绑：账号 unbound、上下文清空、凭据作废，总览为 null；这个微信可以再绑给别人", async () => {
  const before = await runAsTenant(alice, () => wechatStore.account(alice));
  const credentialId = before?.credentialId ?? "";

  const response = await call(app, alice, "DELETE", "/wechat");
  expect(response.status).toBe(204);
  expect((await overview(alice)).body.wechat).toBeNull();

  const after = await runAsTenant(alice, () => wechatStore.account(alice));
  expect(after?.status).toBe("unbound");
  expect(after?.contextToken).toBeNull();
  const [credential] = await asPlatform(() =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, credentialId)),
  );
  expect(credential?.revokedAt).toBeInstanceOf(Date);

  // 再解绑一次也无妨。
  expect((await call(app, alice, "DELETE", "/wechat")).status).toBe(204);

  const attempt = await start(bob);
  ilink.answer(
    attempt.qrcode,
    confirmed(`${prefix}-ilink-alice`, `${prefix}-BOB-TOKEN-2`),
  );
  expect((await poll(bob, attempt.attemptId)).body.status).toBe("bound");
  expect((await overview(bob)).body.wechat?.status).toBe("bound");
});

test("同一个人重新绑定：旧凭据作废，账号指向新凭据", async () => {
  const first = await runAsTenant(bob, () => wechatStore.account(bob));
  const attempt = await start(bob);
  ilink.answer(
    attempt.qrcode,
    confirmed(`${prefix}-ilink-bob-new`, `${prefix}-BOB-TOKEN-3`),
  );
  expect((await poll(bob, attempt.attemptId)).body.status).toBe("bound");
  const second = await runAsTenant(bob, () => wechatStore.account(bob));
  expect(second?.credentialId).not.toBe(first?.credentialId ?? "");
  const live = (await liveWechatCredentials(bob)).filter(
    (row) => !row.revokedAt,
  );
  expect(live.map((row) => row.id)).toEqual([second?.credentialId ?? ""]);
  const [row] = await asPlatform(() =>
    database
      .select({ ilinkUserId: wechatAccounts.ilinkUserId })
      .from(wechatAccounts)
      .where(eq(wechatAccounts.userId, bob)),
  );
  expect(row?.ilinkUserId).toBe(`${prefix}-ilink-bob-new`);
});

test("没接微信的部署：available.wechat 为 false，总览为 null，开始绑定被拒", async () => {
  const bare = appWith();
  const { body } = await overview(alice, bare);
  expect(body.available.wechat).toBe(false);
  expect(body.wechat).toBeNull();
  expect((await call(bare, alice, "POST", "/wechat/start")).status).toBe(400);
});

test("已断开的账号：总览返回 disconnected，不占着这个微信，别人可以绑；本人重新扫码回到 bound", async () => {
  const mine = await runAsTenant(bob, () => wechatStore.account(bob));
  await runAsTenant(bob, () => wechatStore.disconnect(mine?.id ?? ""));
  const { body } = await overview(bob);
  expect(body.wechat?.status).toBe("disconnected");
  expect(body.wechat?.pausedUntil).toBeNull();
  expect(body.wechat?.lastInboundAt).toBeNull();
  // 已断开时，即使最近有入站，时间窗也不算开着。
  await runAsTenant(bob, () =>
    wechatStore.markInbound(mine?.id ?? "", { at: new Date() }),
  );
  expect((await overview(bob)).body.wechat?.windowOpen).toBe(false);

  const theirs = await start(carol);
  ilink.answer(
    theirs.qrcode,
    confirmed(`${prefix}-ilink-bob-new`, `${prefix}-CAROL-TOKEN-1`),
  );
  expect((await poll(carol, theirs.attemptId)).body.status).toBe("bound");
  expect((await overview(carol)).body.wechat?.status).toBe("bound");

  const again = await start(bob);
  ilink.answer(
    again.qrcode,
    confirmed(`${prefix}-ilink-bob-again`, `${prefix}-BOB-TOKEN-4`),
  );
  expect((await poll(bob, again.attemptId)).body.status).toBe("bound");
  expect((await overview(bob)).body.wechat?.status).toBe("bound");
});

test("部署开关 WECHAT_ENABLED：默认开，false / 0 / off 关", () => {
  expect(wechatEnabled(undefined)).toBe(true);
  expect(wechatEnabled("")).toBe(true);
  expect(wechatEnabled("true")).toBe(true);
  expect(wechatEnabled("1")).toBe(true);
  for (const off of ["false", "0", "off", " OFF ", "False"])
    expect(wechatEnabled(off)).toBe(false);
});

test("连不上微信：开始绑定、查进度、解绑失败都回中文，不露服务器英文", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const down = appWith({
      database,
      ilink: {
        async getBotQrcode() {
          throw new DeliveryProviderError("WeChat", "network_error", true);
        },
        async getQrcodeStatus() {
          throw new Error("socket hang up");
        },
      },
      store: {
        ...wechatStore,
        async unbind() {
          throw new Error("connection terminated");
        },
      },
      credentials: credentialStore,
      encryptionKey: KEY,
    });
    const started = await call(down, erin, "POST", "/wechat/start");
    expect(started.status).toBe(503);
    expect(await started.json()).toEqual({
      error: "暂时连不上微信，请稍后再试",
    });

    // 查进度：二维码是好的部署发的，问微信时出了意外。
    const attempt = await start(erin);
    const checked = await call(
      down,
      erin,
      "GET",
      `/wechat/attempts/${attempt.attemptId}`,
    );
    expect(checked.status).toBe(503);
    expect(await checked.json()).toEqual({
      error: "暂时连不上微信，请稍后再试",
    });

    const removed = await call(down, erin, "DELETE", "/wechat");
    expect(removed.status).toBe(503);
    expect(await removed.json()).toEqual({
      error: "暂时连不上微信，请稍后再试",
    });

    // 别的渠道不变：仍是原来的英文。
    const other = await call(down, erin, "DELETE", "/bindings/nope");
    expect(other.status).not.toBe(200);
    const body = (await other.json()) as { error?: string };
    expect(body.error ?? "").not.toBe("暂时连不上微信，请稍后再试");
  } finally {
    console.error = quiet;
  }
});

test("绑好后试着在微信里发一句「已绑定」；发不出也不影响绑定", async () => {
  const welcomed: string[] = [];
  const greeter = appWith({
    database,
    ilink: ilink.client,
    store: wechatStore,
    credentials: credentialStore,
    encryptionKey: KEY,
    welcome: async (userId) => {
      welcomed.push(userId);
    },
  });
  const mine = await start(frank, greeter);
  ilink.answer(
    mine.qrcode,
    confirmed(`${prefix}-ilink-frank`, `${prefix}-FRANK-TOKEN-1`),
  );
  expect((await poll(frank, mine.attemptId, greeter)).body.status).toBe(
    "bound",
  );
  expect(welcomed).toEqual([frank]);
  // 真的那一句：用这个人刚封好的令牌，发给他自己的微信；还没有 context_token 就空着发。
  const said: { token: string; to: string; context: string; text: string }[] =
    [];
  await runAsTenant(frank, () =>
    createWechatWelcome({
      ilink: {
        async sendText(session, input) {
          said.push({
            token: session.botToken,
            to: input.toUserId,
            context: input.contextToken,
            text: input.text,
          });
        },
      },
      credentials: credentialStore,
      keyEncryptionKey: KEY,
      wechat: wechatStore,
      text: WECHAT_WELCOME_TEXT,
    })(frank),
  );
  expect(said).toEqual([
    {
      token: `${prefix}-FRANK-TOKEN-1`,
      to: `${prefix}-ilink-frank`,
      context: "",
      text: "已绑定，直接在这里给员工派活",
    },
  ]);
  // 再问一次（已经绑好）：不再发。
  expect((await poll(frank, mine.attemptId, greeter)).body.status).toBe(
    "bound",
  );
  expect(welcomed).toEqual([frank]);

  const quiet = console.error;
  console.error = () => {};
  try {
    const failing = appWith({
      database,
      ilink: ilink.client,
      store: wechatStore,
      credentials: credentialStore,
      encryptionKey: KEY,
      welcome: async () => {
        throw new Error("ret=-2");
      },
    });
    const again = await start(frank, failing);
    ilink.answer(
      again.qrcode,
      confirmed(`${prefix}-ilink-frank`, `${prefix}-FRANK-TOKEN-2`),
    );
    expect((await poll(frank, again.attemptId, failing)).body.status).toBe(
      "bound",
    );
    expect((await overview(frank, failing)).body.wechat?.status).toBe("bound");
  } finally {
    console.error = quiet;
  }
});

test("总览的时间窗和出站用同一个判断：没有 context_token、暂停着都不算开着", async () => {
  const mine = await start(gina);
  ilink.answer(
    mine.qrcode,
    confirmed(`${prefix}-ilink-gina`, `${prefix}-GINA-TOKEN-1`),
  );
  expect((await poll(gina, mine.attemptId)).body.status).toBe("bound");
  const account = await runAsTenant(gina, () => wechatStore.account(gina));
  // 刚来过信但没带 context_token：发不出去，所以不算开着。
  await runAsTenant(gina, () =>
    wechatStore.markInbound(account?.id ?? "", { at: new Date() }),
  );
  expect((await overview(gina)).body.wechat?.windowOpen).toBe(false);
  await runAsTenant(gina, () =>
    wechatStore.markInbound(account?.id ?? "", {
      at: new Date(),
      contextToken: `${prefix}-ctx-gina`,
    }),
  );
  expect((await overview(gina)).body.wechat?.windowOpen).toBe(true);
  await runAsTenant(gina, () =>
    wechatStore.pause(account?.id ?? "", new Date(Date.now() + 60 * 60_000)),
  );
  const paused = (await overview(gina)).body.wechat;
  expect(paused?.paused).toBe(true);
  expect(paused?.windowOpen).toBe(false);
});
