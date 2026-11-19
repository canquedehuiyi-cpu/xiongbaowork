import { afterAll, describe, expect, test } from "bun:test";
import {
  announceRunNotice,
  type ChannelActivityEvent,
  createChannelEventHub,
  type RunNoticeWire,
  startChannelActivityListener,
} from "../src/channels/events";
import { createDatabase, type Database } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A turn that ended while its person was away reaches their open pages as a system notification
 * (期九·五). It travels the roster's own rail, through Postgres, to the person it is for alone, as an
 * event that names no roster row.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

afterAll(async () => {
  await database.$client.end();
});

const notice: RunNoticeWire = {
  channelId: "chat-1",
  title: "熊宝",
  body: "研究员：竞品对比报告已写好。（用时 18 分钟）",
  tag: "xiongbao-chat-1",
  path: "/channel/chat-1",
};

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(25);
}

describe("announcing that a turn ended", () => {
  test("only the person it is for hears it, on every page they have open", async () => {
    const hub = createChannelEventHub();
    const first: ChannelActivityEvent[] = [];
    const second: ChannelActivityEvent[] = [];
    const stranger: ChannelActivityEvent[] = [];
    hub.register("notice-alice", (payload) => first.push(JSON.parse(payload)));
    hub.register("notice-alice", (payload) => second.push(JSON.parse(payload)));
    hub.register("notice-bob", (payload) => stranger.push(JSON.parse(payload)));
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      await announceRunNotice(database, "notice-alice", notice);
      await until(() => first.length > 0 && second.length > 0);
    } finally {
      await listener.stop();
    }
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(stranger).toEqual([]);
    expect(first[0]).toEqual({
      // No roster row: a page that does not know this field cannot take it for a preview.
      channelId: "",
      memberIds: ["notice-alice"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      runNotice: notice,
    });
  });

  test("a notification that cannot be sent is the caller's to hear about", async () => {
    const failing = {
      execute: () => Promise.reject(new Error("connection lost")),
    } as unknown as Pick<Database, "execute">;
    await expect(
      announceRunNotice(failing, "notice-alice", notice),
    ).rejects.toThrow("connection lost");
  });
});
