import { describe, expect, test } from "bun:test";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
} from "../src/channels/events";
import type { Database } from "../src/db/client";
import { boardStateDelta, createBoardPush } from "../src/tasks/board-push";

const at = (iso: string) => new Date(iso);

describe("boardStateDelta", () => {
  const since = at("2026-11-24T10:00:00.000Z");

  test("a card changed since the last push is one replace of its status, with nothing else", () => {
    const delta = boardStateDelta(
      [
        {
          id: "card-1",
          status: "needs_action",
          createdAt: at("2026-11-24T09:00:00.000Z"),
          updatedAt: at("2026-11-24T10:00:05.000Z"),
        },
      ],
      since,
    );
    expect(delta).toEqual([
      { op: "replace", path: "/tasks/card-1/status", value: "needs_action" },
    ]);
  });

  test("a card made since the last push is an add carrying only its status", () => {
    const delta = boardStateDelta(
      [
        {
          id: "card-2",
          status: "running",
          createdAt: at("2026-11-24T10:00:01.000Z"),
          updatedAt: at("2026-11-24T10:00:01.000Z"),
        },
      ],
      since,
    );
    expect(delta).toEqual([
      { op: "add", path: "/tasks/card-2", value: { status: "running" } },
    ]);
  });
});

describe("the hub's STATE_DELTA delivery", () => {
  const delta = [
    { op: "replace", path: "/tasks/card-1/status", value: "done" },
  ] as const;
  const event = (memberIds: string[]): ChannelActivityEvent => ({
    channelId: "",
    memberIds,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    stateDelta: [...delta],
  });

  test("sends the AG-UI shape and nothing of the wrapper, to the person alone", () => {
    const hub = createChannelEventHub();
    const mine: string[] = [];
    const theirs: string[] = [];
    hub.register("user-a", (payload) => mine.push(payload));
    hub.register("user-b", (payload) => theirs.push(payload));

    hub.deliver(event(["user-a"]));

    expect(mine.map((raw) => JSON.parse(raw))).toEqual([
      { type: "STATE_DELTA", delta },
    ]);
    expect(theirs).toEqual([]);
  });
});

describe("with the switch off", () => {
  test("announcing touches neither the database nor the notification channel", async () => {
    const touched: string[] = [];
    const database = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          throw new Error("the database must not be used");
        },
      },
    ) as unknown as Database;

    await createBoardPush(database, { enabled: false }).announce("user-a");

    expect(touched).toEqual([]);
  });
});
