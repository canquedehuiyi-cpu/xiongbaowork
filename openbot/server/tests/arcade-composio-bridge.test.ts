import { describe, expect, test } from "bun:test";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import type { ArcadeBroker } from "../src/plugins/broker";

/**
 * fork X5：Arcade 的 broker 桥接到 fork store 与路由使用的 `{ userId }` 形状。
 *
 * fork 的 `userId` 就是发给厂商的用户 id，所以桥接只能把它原样放进 `vendorUserId`，不能推导出别的 id
 * （那样每个人的调用都会落到别人的账号上）。Connect 走桥接时不交出 mint id：Arcade 的连接必须经过
 * 带发起人绑定的授权尝试（路由层），桥接自己的 `authorize` 拿不到能完成的回程。
 */
function recording() {
  const seen: unknown[] = [];
  const answer =
    <T>(value: T) =>
    async (request?: unknown) => {
      seen.push(request);
      return value;
    };
  const arcade = {
    grantIsLocal: true,
    authorizations: {
      status: answer({ status: "completed", userId: null, scopes: [] }),
      confirmReturn: answer({ authorizationId: "a" }),
    },
    grantsFor: answer([]),
    authProviderOf: answer(null),
    listApps: answer([]),
    ensureAuthConfig: answer("not-needed" as const),
    deleteAuthConfig: answer(undefined),
    authorize: answer({
      redirectUrl: "https://consent",
      authorizationId: "m1",
    }),
    accountsOf: answer([]),
    isConnected: answer(true),
    revoke: answer(true),
    connectionFields: answer([]),
    connectWithFields: answer({ accountId: "x" }),
    revokeAccount: answer(undefined),
    accountName: answer(null),
  } satisfies ArcadeBroker;
  return { arcade, seen };
}

describe("asComposioBroker", () => {
  test("the fork's userId is the vendor user id, and nothing else is derived", async () => {
    const { arcade, seen } = recording();
    const broker = asComposioBroker(arcade);
    expect(
      await broker.isConnected({ userId: "user_a", toolkit: "Gmail" }),
    ).toBe(true);
    await broker.revoke({ userId: "openbot-deployment:d:r", toolkit: "Gmail" });
    expect(seen).toEqual([
      {
        account: { holder: "person", userId: "user_a", vendorUserId: "user_a" },
        toolkit: "Gmail",
      },
      {
        account: {
          holder: "person",
          userId: "openbot-deployment:d:r",
          vendorUserId: "openbot-deployment:d:r",
        },
        toolkit: "Gmail",
      },
    ]);
  });

  test("authorize through the bridge hands back only the link, never the mint id", async () => {
    const { arcade } = recording();
    const answer = await asComposioBroker(arcade).authorize({
      userId: "user_a",
      toolkit: "Gmail",
      returnUrl: "https://openbot.test/back",
    });
    expect(answer).toEqual({ redirectUrl: "https://consent" });
  });

  test("the Arcade broker itself rides along for the routes that need its flow", () => {
    const { arcade } = recording();
    expect(asComposioBroker(arcade).arcade).toBe(arcade);
  });
});
