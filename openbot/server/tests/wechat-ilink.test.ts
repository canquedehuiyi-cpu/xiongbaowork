import { describe, expect, test } from "bun:test";
import {
  createIlinkClient,
  IlinkPausedError,
  IlinkUnauthorizedError,
  IlinkWindowClosedError,
} from "../src/delivery/wechat/ilink";

type Call = { url: string; init: RequestInit };

function fake(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const session = { baseUrl: "https://ilink.example", botToken: "t1" };

describe("iLink client", () => {
  test("getUpdates sends protocol headers and the cursor, maps messages", async () => {
    const { calls, fetchImpl } = fake(() =>
      json({
        ret: 0,
        get_updates_buf: "",
        longpolling_timeout_ms: 20000,
        msgs: [
          {
            message_id: 7,
            from_user_id: "u1",
            context_token: "c1",
            item_list: [{ type: 1, text_item: { text: "你好" } }],
          },
          {
            seq: 9,
            from_user_id: "u1",
            item_list: [{ type: 2, image_item: {} }],
          },
        ],
      }),
    );
    const client = createIlinkClient({
      fetch: fetchImpl,
      clientVersion: "2.4.10",
    });
    const out = await client.getUpdates(session, "cur-1");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("https://ilink.example/ilink/bot/getupdates");
    expect(headers.Authorization).toBe("Bearer t1");
    expect(headers.AuthorizationType).toBe("ilink_bot_token");
    expect(headers["iLink-App-Id"]).toBe("bot");
    expect(headers["iLink-App-ClientVersion"]).toBe("132106");
    expect(
      Number.isInteger(
        Number(
          Buffer.from(headers["X-WECHAT-UIN"] as string, "base64").toString(),
        ),
      ),
    ).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body)).get_updates_buf).toBe(
      "cur-1",
    );
    expect(out.cursor).toBeNull();
    expect(out.timeoutMs).toBe(20000);
    expect(out.messages[0]).toEqual({
      id: "7",
      fromUserId: "u1",
      text: "你好",
      contextToken: "c1",
      groupId: null,
    });
    expect(out.messages[1]?.text).toBeNull();
    expect(out.messages[1]?.id).toBe("9");
  });

  test("getUpdates returns a non-empty cursor and defaults the timeout", async () => {
    const { fetchImpl } = fake(() =>
      json({ ret: 0, get_updates_buf: "next", msgs: [] }),
    );
    const client = createIlinkClient({
      fetch: fetchImpl,
      clientVersion: "2.4.10",
    });
    expect(await client.getUpdates(session, "")).toEqual({
      messages: [],
      cursor: "next",
      timeoutMs: 35000,
    });
  });

  test("getQrcodeStatus carries no Authorization and returns the session on confirm", async () => {
    const { calls, fetchImpl } = fake(() =>
      json({
        status: "confirmed",
        bot_token: "t1",
        ilink_bot_id: "b1",
        ilink_user_id: "u1",
        baseurl: "https://x.example",
      }),
    );
    const client = createIlinkClient({
      fetch: fetchImpl,
      clientVersion: "2.4.10",
    });
    const out = await client.getQrcodeStatus("qr1");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["iLink-App-Id"]).toBe("bot");
    expect(calls[0]?.url).toContain("qrcode=qr1");
    expect(out).toEqual({
      status: "confirmed",
      session: {
        baseUrl: "https://x.example",
        botToken: "t1",
        botId: "b1",
        userId: "u1",
      },
    });
  });

  test("getBotQrcode returns qrcode and image content", async () => {
    const { fetchImpl } = fake(() =>
      json({ qrcode: "q", qrcode_img_content: "http://img" }),
    );
    const client = createIlinkClient({
      fetch: fetchImpl,
      clientVersion: "2.4.10",
    });
    expect(await client.getBotQrcode()).toEqual({
      qrcode: "q",
      imageContent: "http://img",
    });
  });

  test("ret -14 pauses, send failure closes the window, 401 is unauthorized", async () => {
    const client = (h: () => Response) =>
      createIlinkClient({ fetch: fake(h).fetchImpl, clientVersion: "2.4.10" });
    await expect(
      client(() => json({ ret: -14 })).getUpdates(session, ""),
    ).rejects.toBeInstanceOf(IlinkPausedError);
    await expect(
      client(() => json({ ret: -2 })).sendText(session, {
        toUserId: "u",
        contextToken: "c",
        text: "x",
      }),
    ).rejects.toBeInstanceOf(IlinkWindowClosedError);
    await expect(
      client(() => json({}, 401)).getUpdates(session, ""),
    ).rejects.toBeInstanceOf(IlinkUnauthorizedError);
    await expect(
      client(() => json({ ret: 0 })).sendText(session, {
        toUserId: "u",
        contextToken: "c",
        text: "x",
      }),
    ).resolves.toBeUndefined();
  });

  test("errors never contain the token", async () => {
    const c = createIlinkClient({
      fetch: fake(() => json({}, 401)).fetchImpl,
      clientVersion: "2.4.10",
    });
    const err = await c.getUpdates(session, "").catch((e) => e as Error);
    expect(String(err.message)).not.toContain("t1");
    expect(err).toMatchObject({ provider: "wechat", code: "unauthorized" });
  });
});
