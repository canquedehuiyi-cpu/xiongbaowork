import { describe, expect, test } from "bun:test";
import { createDeliveryRouter } from "../src/delivery/router";
import type { DeliveryBinding, PushDevice } from "../src/delivery/types";
import { runAsTenant } from "../src/tenant/context";

/**
 * A `reply` that says a turn ended while its person was away goes to the places they are (期九·五),
 * through the same router and the same gates as every other reply: their routing for progress, the
 * Bot's notification level and WeChat's time window. What is new is only that it is sent to WeChat even
 * when the turn began in the browser, and that the person's switches for the phone and for the chat
 * platforms are honoured.
 */

type RouterStore = Parameters<typeof createDeliveryRouter>[0]["store"];

const scope = {
  ownerUserId: "alice",
  channelId: "chat-1",
  agentId: "worker",
  threadId: "thread-1",
};
const device: PushDevice = {
  id: "phone",
  ownerUserId: "alice",
  token: "token",
  projectId: "p",
  platform: "ios",
  enabled: true,
};
const slack: DeliveryBinding = {
  ...scope,
  id: "slack-binding",
  transport: "slack",
  realm: "T",
  identity: "U",
  address: "D",
  enabled: true,
};
/** A WeChat account bound to another conversation, the one the person last used there. */
const wechatElsewhere: DeliveryBinding = {
  ownerUserId: "alice",
  channelId: "chat-2",
  agentId: "other-bot",
  threadId: "thread-2",
  id: "wechat-binding",
  transport: "wechat",
  realm: "wechat",
  identity: "wx-1",
  address: "wx-1",
  enabled: true,
};
const wechatHere: DeliveryBinding = {
  ...wechatElsewhere,
  channelId: scope.channelId,
  agentId: scope.agentId,
  threadId: scope.threadId,
};

type Row = {
  transport: string;
  text: string;
  kind: string;
  dedupeKey: string;
  channelId: string;
  agentId: string;
  threadId: string;
  bindingId: string | null;
  deviceId: string | null;
};

function fixture(
  options: {
    here?: DeliveryBinding[];
    used?: DeliveryBinding[];
    devices?: PushDevice[];
    wechatOpen?: boolean;
    allows?: (transport: string) => boolean;
    notify?: boolean;
    wechatProvider?: boolean;
  } = {},
) {
  const rows: Row[] = [];
  const store = {
    bindingsFor: async () => options.here ?? [slack],
    bindingsByUse: async () => options.used ?? options.here ?? [slack],
    devices: async () => options.devices ?? [device],
    // The last round on a binding came from the web, or there was none: never a WeChat round.
    latestInbox: async () => null,
    setInbox: async () => {},
    offerOutbox: async (row: Row) => {
      rows.push(row);
      return row;
    },
  };
  const router = createDeliveryRouter({
    store: store as unknown as RouterStore,
    queue: {
      claim: async () => [],
      renew: async () => true,
      finish: async () => true,
      release: async () => true,
    },
    owner: "worker",
    authoriseScope: async () => true,
    scopeFor: async () => null,
    runTurn: async () => ({ replyText: "" }),
    providers: {
      slack: { send: async () => ({ id: "ts", status: "sent" as const }) },
      ...(options.wechatProvider === false
        ? {}
        : {
            wechat: {
              send: async () => ({ id: "wx", status: "sent" as const }),
            },
          }),
    },
    wechatWindow: {
      open: async () => options.wechatOpen ?? true,
      missed: async () => {},
    },
    routeFor: async () => ({
      kind: "progress",
      notify: options.notify ?? true,
      allows: (transport) => (options.allows ?? (() => true))(transport),
    }),
  });
  const away = (
    switches: { push?: boolean; chat?: boolean } = {},
  ): Promise<void> =>
    runAsTenant("alice", () =>
      router.notify(scope, {
        id: "turn-end:run-1",
        kind: "reply",
        text: "研究员：做完了。（用时 18 分钟）",
        away: {
          push: switches.push ?? true,
          chat: switches.chat ?? true,
          chatText: "做完了。（用时 18 分钟）",
        },
      }),
    );
  const plain = (): Promise<void> =>
    runAsTenant("alice", () =>
      router.notify(scope, {
        id: "plain-1",
        kind: "reply",
        text: "研究员：做完了。",
      }),
    );
  return { rows, away, plain, router };
}

const transports = (rows: Row[]) => rows.map((row) => row.transport).sort();

describe("the phone and the chat platforms", () => {
  test("both are told: the phone gets the full line as a reply, the platform that posts as the Bot gets it without the name", async () => {
    const f = fixture();
    await f.away();
    expect(transports(f.rows)).toEqual(["push", "slack"]);
    const push = f.rows.find((row) => row.transport === "push");
    expect(push).toMatchObject({
      kind: "reply",
      text: "研究员：做完了。（用时 18 分钟）",
      // A tap on a reply opens this conversation (delivery/push.ts).
      channelId: "chat-1",
      threadId: "thread-1",
    });
    expect(f.rows.find((row) => row.transport === "slack")?.text).toBe(
      "做完了。（用时 18 分钟）",
    );
  });

  test("the phone switched off: only the chat platform is told", async () => {
    const f = fixture();
    await f.away({ push: false });
    expect(transports(f.rows)).toEqual(["slack"]);
  });

  test("the chat platforms switched off: only the phone is told", async () => {
    const f = fixture();
    await f.away({ chat: false });
    expect(transports(f.rows)).toEqual(["push"]);
  });

  test("both switched off: nothing is queued", async () => {
    const f = fixture();
    await f.away({ push: false, chat: false });
    expect(f.rows).toHaveLength(0);
  });

  test("the same notice is keyed by its turn, so a retry queues nothing new", async () => {
    const f = fixture();
    await f.away();
    expect(f.rows.map((row) => row.dedupeKey).sort()).toEqual([
      "reply:turn-end:run-1:binding:slack-binding",
      "reply:turn-end:run-1:device:phone",
    ]);
  });

  test("the person's routing for progress still decides: a phone they routed away is not told", async () => {
    const f = fixture({ allows: (transport) => transport !== "push" });
    await f.away();
    expect(transports(f.rows)).toEqual(["slack"]);
  });

  test("a Bot the person told to notify them of nothing sends nothing", async () => {
    const f = fixture({ notify: false, allows: () => false });
    await f.away();
    expect(f.rows).toHaveLength(0);
  });
});

describe("WeChat", () => {
  test("a reply from a turn begun in the browser is never pushed to WeChat -- unless it is this notice", async () => {
    const plain = fixture({ here: [wechatHere] });
    await plain.plain();
    expect(plain.rows.filter((row) => row.transport === "wechat")).toHaveLength(
      0,
    );

    const away = fixture({ here: [wechatHere] });
    await away.away();
    expect(away.rows.filter((row) => row.transport === "wechat")).toHaveLength(
      1,
    );
  });

  test("WeChat the person did not opt in to is not told: the routing says so", async () => {
    const f = fixture({
      here: [wechatHere],
      allows: (transport) => transport !== "wechat",
    });
    await f.away();
    expect(transports(f.rows)).toEqual(["push"]);
  });

  test("WeChat's time window closed: nothing is queued for it, and the phone is still told", async () => {
    const f = fixture({ here: [wechatHere], wechatOpen: false });
    await f.away();
    expect(transports(f.rows)).toEqual(["push"]);
  });

  test("a deployment with WeChat off tells nobody there", async () => {
    const f = fixture({ here: [wechatHere], wechatProvider: false });
    await f.away();
    expect(transports(f.rows)).toEqual(["push"]);
  });

  test("a conversation with no WeChat of its own falls back to the account the person used last, and says whose turn it was", async () => {
    const f = fixture({ here: [], used: [wechatElsewhere] });
    await f.away();
    const wechat = f.rows.find((row) => row.transport === "wechat");
    // Filed under the conversation that account is bound to, as an approval's fallback is.
    expect(wechat).toMatchObject({
      channelId: "chat-2",
      agentId: "other-bot",
      threadId: "thread-2",
      // The platform posts as that other Bot, so the employee's name has to be in the line.
      text: "研究员：做完了。（用时 18 分钟）",
    });
  });

  test("a WeChat bound to this very conversation already posts as this Bot: no name twice", async () => {
    const f = fixture({ here: [wechatHere] });
    await f.away();
    expect(f.rows.find((row) => row.transport === "wechat")?.text).toBe(
      "做完了。（用时 18 分钟）",
    );
  });

  test("the chat platforms switched off: WeChat is not told either", async () => {
    const f = fixture({ here: [wechatHere], used: [wechatHere] });
    await f.away({ chat: false });
    expect(transports(f.rows)).toEqual(["push"]);
  });
});

describe("a notice about somebody else's conversation", () => {
  test("is queued only from inside its owner's own frame", async () => {
    const f = fixture();
    const input = {
      id: "turn-end:run-2",
      kind: "reply" as const,
      text: "研究员：做完了。",
      away: { push: true, chat: true, chatText: "做完了。" },
    };
    await runAsTenant("bob", () => f.router.notify(scope, input));
    await runAsTenant("platform", () => f.router.notify(scope, input));
    expect(f.rows).toHaveLength(0);
    await runAsTenant("alice", () => f.router.notify(scope, input));
    expect(f.rows.length).toBeGreaterThan(0);
  });
});
