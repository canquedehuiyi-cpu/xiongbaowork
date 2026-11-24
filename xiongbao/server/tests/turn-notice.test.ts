import { describe, expect, test } from "bun:test";
import type { RunEndNoticePreferences } from "@xiongbao/shared/user-preferences";
import { productName } from "../src/brand";
import type { DeliveryScope } from "../src/delivery/types";
import {
  createTurnNotifier,
  elapsedWords,
  type RunNotice,
  type TurnEnd,
  type TurnEndedInput,
  turnNoticeText,
} from "../src/threads/turn-notice";

/**
 * A chat turn that ends while nobody is looking at it tells the person (期九·五): who is looking, what
 * is said for each way a turn can end, the three switches, the once-a-minute merge, and that a turn is
 * never told to somebody else.
 */

const MIN = 60_000;

type Told = {
  scope: DeliveryScope;
  input: {
    id: string;
    kind: "reply";
    text: string;
    away: { push: boolean; chat: boolean; chatText: string };
  };
};

function fixture(
  options: {
    viewers?: Record<string, number>;
    switches?: Partial<RunEndNoticePreferences>;
    oneToOne?: boolean;
    windowMs?: number;
    name?: string | undefined;
    notifyFails?: boolean;
    announceFails?: boolean;
  } = {},
) {
  let clock = 1_000_000;
  const told: Told[] = [];
  const announced: { ownerUserId: string; notice: RunNotice }[] = [];
  const logged: Record<string, unknown>[] = [];
  const viewers = { ...(options.viewers ?? {}) };
  const failing = {
    notify: options.notifyFails === true,
    announce: options.announceFails === true,
  };
  const switches: RunEndNoticePreferences = {
    push: true,
    im: true,
    desktop: true,
    ...(options.switches ?? {}),
  };
  const notifier = createTurnNotifier({
    viewers: (owner, thread) => viewers[`${owner}/${thread}`] ?? 0,
    preferences: async () => switches,
    conversation: async ({ ownerUserId, threadId }) =>
      options.oneToOne === false
        ? null
        : { channelId: `channel-of-${ownerUserId}-${threadId}` },
    botName: async () => ("name" in options ? options.name : "研究员"),
    notify: async (scope, input) => {
      if (failing.notify) throw new Error("outbox down");
      told.push({ scope, input });
    },
    announce: async (ownerUserId, notice) => {
      if (failing.announce) throw new Error("notify down");
      announced.push({ ownerUserId, notice });
    },
    windowMs: options.windowMs ?? MIN,
    now: () => clock,
    log: (event) => logged.push(event),
  });
  const ended = (
    end: TurnEnd,
    over: Partial<TurnEndedInput> = {},
  ): ReturnType<typeof notifier.ended> =>
    notifier.ended({
      ownerUserId: "alice",
      agentId: "worker",
      threadId: "t1",
      runId: `run-${Math.random()}`,
      startedAt: clock - 18 * MIN,
      end,
      ...over,
    });
  return {
    ended,
    told,
    announced,
    logged,
    viewers,
    failing,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("what a notice says", () => {
  test("an answer is the employee, its first sentence and how long it took", () => {
    expect(
      turnNoticeText({
        name: "研究员",
        end: {
          kind: "finished",
          text: "竞品对比报告已写好，存在 report.md。\n\n下面是摘要……",
        },
        elapsedMs: 18 * MIN,
      }),
    ).toBe("研究员：竞品对比报告已写好，存在 report.md。（用时 18 分钟）");
  });

  test("the first sentence is cut to a length a notification can hold", () => {
    const long = `${"很长的一句话".repeat(40)}。后面还有。`;
    const text = turnNoticeText({
      name: "研究员",
      end: { kind: "finished", text: long },
      elapsedMs: 2 * MIN,
    });
    expect(Array.from(text).length).toBeLessThan(120);
    expect(text.startsWith("研究员：很长的一句话")).toBe(true);
    expect(text.endsWith("（用时 2 分钟）")).toBe(true);
  });

  test("a turn that said nothing is still reported as done", () => {
    expect(
      turnNoticeText({
        name: "研究员",
        end: { kind: "finished", text: "  " },
        elapsedMs: 40_000,
      }),
    ).toBe("研究员：这一轮做完了（用时 40 秒）");
  });

  test("each other way a turn can end has its own words", () => {
    const say = (end: TurnEnd, elapsedMs = 25 * MIN) =>
      turnNoticeText({ name: "研究员", end, elapsedMs });
    expect(say({ kind: "failed" })).toBe(
      "研究员：这一轮出错停下了，回到对话里看看（用时 25 分钟）",
    );
    expect(say({ kind: "needs-you" })).toBe(
      "研究员：需要你来处理，这一轮先停在这里（用时 25 分钟）",
    );
    expect(say({ kind: "needs-you", waiting: "computer_handoff" })).toBe(
      "研究员：需要你接管一下浏览器，这一轮先停在这里（用时 25 分钟）",
    );
    expect(say({ kind: "needs-you", waiting: "computer_secret" })).toBe(
      "研究员：需要你填一个值，这一轮先停在这里（用时 25 分钟）",
    );
    expect(say({ kind: "limit", reason: "time", minutes: 25 })).toBe(
      "研究员：这一轮已经跑满 25 分钟，先停下了，回复「继续」接着做",
    );
    expect(say({ kind: "limit", reason: "segments" })).toBe(
      "研究员：这一轮连续调用工具的次数到了上限，先停下了，回复「继续」接着做（用时 25 分钟）",
    );
    expect(say({ kind: "interrupted" })).toBe(
      "研究员：服务重启，这一轮在中途被打断了，回复「继续」接着做（已跑 25 分钟）",
    );
  });

  test("a platform that already posts as the employee gets the line without the name", () => {
    expect(
      turnNoticeText({
        name: "研究员",
        end: { kind: "finished", text: "做完了。" },
        elapsedMs: 3 * MIN,
        speaker: false,
      }),
    ).toBe("做完了。（用时 3 分钟）");
  });

  test("how long a turn took is said in the unit a person reads", () => {
    expect(elapsedWords(0)).toBe("1 秒");
    expect(elapsedWords(45_000)).toBe("45 秒");
    expect(elapsedWords(90_000)).toBe("2 分钟");
    expect(elapsedWords(60 * MIN)).toBe("1 小时");
    expect(elapsedWords(65 * MIN)).toBe("1 小时 5 分钟");
  });
});

describe("when a person is told", () => {
  test("not while a page is watching the conversation", async () => {
    const f = fixture({ viewers: { "alice/t1": 1 } });
    expect(await f.ended({ kind: "finished", text: "好了。" })).toEqual({
      sent: false,
      why: "watched",
    });
    expect(f.told).toHaveLength(0);
    expect(f.announced).toHaveLength(0);
  });

  test("a page watching another conversation does not count", async () => {
    const f = fixture({ viewers: { "alice/other": 3 } });
    const result = await f.ended({ kind: "finished", text: "好了。" });
    expect(result.sent).toBe(true);
  });

  test("when nobody is watching, every way a turn ends is told, in the words of that ending", async () => {
    const ends: [TurnEnd, string][] = [
      [
        { kind: "finished", text: "竞品对比报告已写好，存在 report.md。" },
        "研究员：竞品对比报告已写好，存在 report.md。（用时 18 分钟）",
      ],
      [
        { kind: "failed" },
        "研究员：这一轮出错停下了，回到对话里看看（用时 18 分钟）",
      ],
      [
        { kind: "needs-you", waiting: "computer_handoff" },
        "研究员：需要你接管一下浏览器，这一轮先停在这里（用时 18 分钟）",
      ],
      [
        { kind: "limit", reason: "time", minutes: 25 },
        "研究员：这一轮已经跑满 25 分钟，先停下了，回复「继续」接着做",
      ],
      [
        { kind: "interrupted" },
        "研究员：服务重启，这一轮在中途被打断了，回复「继续」接着做（已跑 18 分钟）",
      ],
    ];
    for (const [end, words] of ends) {
      const f = fixture();
      const result = await f.ended(end);
      expect(result).toEqual({
        sent: true,
        channels: ["push", "im", "desktop"],
      });
      expect(f.told).toHaveLength(1);
      expect(f.told[0]?.input.text).toBe(words);
      expect(f.told[0]?.input.kind).toBe("reply");
      expect(f.announced).toHaveLength(1);
      expect(f.announced[0]?.notice.body).toBe(words);
    }
  });

  test("the notice opens the conversation: its phone message is filed under it, its page notice names it", async () => {
    const f = fixture();
    await f.ended(
      { kind: "finished", text: "好了。" },
      { runId: "run-9", threadId: "t1" },
    );
    expect(f.told[0]?.scope).toEqual({
      ownerUserId: "alice",
      channelId: "channel-of-alice-t1",
      agentId: "worker",
      threadId: "t1",
    });
    expect(f.told[0]?.input.id).toBe("turn-end:run-9");
    expect(f.announced[0]).toEqual({
      ownerUserId: "alice",
      notice: {
        channelId: "channel-of-alice-t1",
        title: productName(),
        body: "研究员：好了。（用时 18 分钟）",
        tag: "xiongbao-channel-of-alice-t1",
        path: "/channel/channel-of-alice-t1",
      },
    });
  });

  test("the chat platforms get the line without the name, the phone and the page the full one", async () => {
    const f = fixture();
    await f.ended({ kind: "finished", text: "好了。" });
    expect(f.told[0]?.input.text).toBe("研究员：好了。（用时 18 分钟）");
    expect(f.told[0]?.input.away.chatText).toBe("好了。（用时 18 分钟）");
  });

  test("an employee whose name cannot be read is told as 你的员工", async () => {
    const f = fixture({ name: undefined });
    await f.ended({ kind: "finished", text: "好了。" });
    expect(f.told[0]?.input.text.startsWith("你的员工：")).toBe(true);
  });

  test("a wait that told the person when it opened is not told again", async () => {
    for (const waiting of ["approval", "computer_sign_in"]) {
      const f = fixture();
      expect(await f.ended({ kind: "needs-you", waiting })).toEqual({
        sent: false,
        why: "told-already",
      });
      expect(f.told).toHaveLength(0);
      expect(f.announced).toHaveLength(0);
    }
  });

  test("a thread that is not a one-to-one conversation (a group, a card) is not told", async () => {
    const f = fixture({ oneToOne: false });
    expect(await f.ended({ kind: "finished", text: "好了。" })).toEqual({
      sent: false,
      why: "not-one-to-one",
    });
    expect(f.told).toHaveLength(0);
    expect(f.announced).toHaveLength(0);
  });
});

describe("the three switches", () => {
  test("the phone off: the chat platforms and the page are still told", async () => {
    const f = fixture({ switches: { push: false } });
    const result = await f.ended({ kind: "finished", text: "好了。" });
    expect(result).toEqual({ sent: true, channels: ["im", "desktop"] });
    expect(f.told[0]?.input.away).toMatchObject({ push: false, chat: true });
    expect(f.announced).toHaveLength(1);
  });

  test("the chat platforms off: the phone and the page are still told", async () => {
    const f = fixture({ switches: { im: false } });
    const result = await f.ended({ kind: "finished", text: "好了。" });
    expect(result).toEqual({ sent: true, channels: ["push", "desktop"] });
    expect(f.told[0]?.input.away).toMatchObject({ push: true, chat: false });
  });

  test("the page off: nothing is announced to open pages, the rest are told", async () => {
    const f = fixture({ switches: { desktop: false } });
    const result = await f.ended({ kind: "finished", text: "好了。" });
    expect(result).toEqual({ sent: true, channels: ["push", "im"] });
    expect(f.announced).toHaveLength(0);
    expect(f.told).toHaveLength(1);
  });

  test("only the page on: the delivery router is not asked at all", async () => {
    const f = fixture({ switches: { push: false, im: false } });
    const result = await f.ended({ kind: "finished", text: "好了。" });
    expect(result).toEqual({ sent: true, channels: ["desktop"] });
    expect(f.told).toHaveLength(0);
  });

  test("all three off: nothing is sent, and the merge window is not used up", async () => {
    const off = fixture({
      switches: { push: false, im: false, desktop: false },
    });
    expect(await off.ended({ kind: "finished", text: "好了。" })).toEqual({
      sent: false,
      why: "switched-off",
    });
    expect(off.told).toHaveLength(0);
    expect(off.announced).toHaveLength(0);
  });
});

describe("turns that end one after another", () => {
  test("a second turn of the same conversation inside the window is not told", async () => {
    const f = fixture();
    expect((await f.ended({ kind: "finished", text: "一。" })).sent).toBe(true);
    f.advance(30_000);
    expect(await f.ended({ kind: "finished", text: "二。" })).toEqual({
      sent: false,
      why: "merged",
    });
    expect(f.told).toHaveLength(1);
    expect(f.announced).toHaveLength(1);
  });

  test("once the window has passed the next turn is told", async () => {
    const f = fixture();
    await f.ended({ kind: "finished", text: "一。" });
    f.advance(MIN);
    expect((await f.ended({ kind: "finished", text: "二。" })).sent).toBe(true);
    expect(f.told).toHaveLength(2);
  });

  test("another conversation, or another person, is told on its own", async () => {
    const f = fixture();
    await f.ended({ kind: "finished", text: "一。" });
    expect(
      (await f.ended({ kind: "finished", text: "二。" }, { threadId: "t2" }))
        .sent,
    ).toBe(true);
    expect(
      (
        await f.ended(
          { kind: "finished", text: "三。" },
          { ownerUserId: "bob", threadId: "t1" },
        )
      ).sent,
    ).toBe(true);
    expect(f.told).toHaveLength(3);
  });

  test("a window of zero tells every turn", async () => {
    const f = fixture({ windowMs: 0 });
    await f.ended({ kind: "finished", text: "一。" });
    await f.ended({ kind: "finished", text: "二。" });
    expect(f.told).toHaveLength(2);
  });

  test("two turns that end at the same moment are one notice", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.ended({ kind: "finished", text: "一。" }),
      f.ended({ kind: "finished", text: "二。" }),
    ]);
    expect([first.sent, second.sent].sort()).toEqual([false, true]);
    expect(f.told).toHaveLength(1);
  });

  test("a turn that was watched, or merged away, does not push the window back", async () => {
    const f = fixture();
    f.viewers["alice/t1"] = 1;
    await f.ended({ kind: "finished", text: "一。" });
    f.viewers["alice/t1"] = 0;
    expect((await f.ended({ kind: "finished", text: "二。" })).sent).toBe(true);
  });
});

describe("a notice that cannot be sent", () => {
  test("never fails the turn: it is logged, and the next turn may try again", async () => {
    const f = fixture({ notifyFails: true, announceFails: true });
    expect(await f.ended({ kind: "finished", text: "好了。" })).toEqual({
      sent: false,
      why: "failed",
    });
    expect(f.logged.length).toBeGreaterThan(0);
    expect(f.logged[0]?.type).toBe("turn-notice-failed");
    // Nothing got through, so the window is still open for the next one.
    f.failing.notify = false;
    f.failing.announce = false;
    expect((await f.ended({ kind: "finished", text: "好了。" })).sent).toBe(
      true,
    );
    expect(f.told).toHaveLength(1);
  });

  test("one carrier failing does not stop the others", async () => {
    const f = fixture({ announceFails: true });
    expect(await f.ended({ kind: "finished", text: "好了。" })).toEqual({
      sent: true,
      channels: ["push", "im"],
    });
    expect(f.told).toHaveLength(1);
  });
});
