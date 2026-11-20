import { describe, expect, test } from "bun:test";
import type { AgentChannel } from "../src/channels/routes";
import { createCardAutonomy } from "../src/tasks/card-autonomy";
import { createBoardCardRoutes } from "../src/tasks/board-cards-routes";
import { cardAsk, cardAutoclaimOn } from "../src/tasks/claim";
import type { BoardCard, BoardCardsStore } from "../src/tasks/claim";
import { Hono } from "hono";
import { runAsTenant } from "../src/tenant/context";

/** 领到卡之后：开卡、跟着走、起一轮；起不来也不失败；开不出卡就放回去；安静时段和开关。 */
const card = (n: number, extra: Partial<BoardCard> = {}): BoardCard =>
  ({
    id: `card-${n}`,
    title: `活 ${n}`,
    detail: "做到能验收",
    role: "前端",
    priority: 0,
    urgent: false,
    status: "claimed",
    claimedBy: "bot",
    taskId: null,
    ...extra,
  }) as BoardCard;

function fixture(
  options: {
    cards?: BoardCard[];
    openFails?: boolean;
    roundFails?: boolean;
    canClaim?: boolean;
    quiet?: boolean;
    trackFails?: boolean;
    enabled?: boolean;
    employees?: string[];
    gate?: string | null;
  } = {},
) {
  const queue = [...(options.cards ?? [card(1), card(2), card(3)])];
  const log = {
    opened: [] as Record<string, unknown>[],
    tracked: [] as string[],
    rounds: [] as string[],
    released: [] as string[],
    recovered: 0,
    started: [] as string[],
    claims: [] as { agent: string; onlyUrgent?: boolean | undefined }[],
  };
  const cards = {
    claimNextCard: async (
      agent: string,
      claim: { onlyUrgent?: boolean } = {},
    ) => {
      log.claims.push({ agent, onlyUrgent: claim.onlyUrgent });
      return queue.shift() ?? null;
    },
    markStarted: async (id: string) => {
      log.started.push(id);
    },
    release: async (id: string, release?: { clearTask?: boolean }) => {
      log.released.push(release?.clearTask ? `${id}:clear` : id);
    },
    recoverStale: async () => {
      log.recovered += 1;
      return 0;
    },
    heartbeatEmployees: async () => options.employees ?? ["bot"],
  } as unknown as BoardCardsStore;
  const autonomy = createCardAutonomy({
    cards,
    board: {
      opened: async (input) => {
        if (options.openFails) throw new Error("quota");
        log.opened.push(input as unknown as Record<string, unknown>);
        return `task-${log.opened.length}`;
      },
    },
    delivery: {
      track: async (_t: string, taskId: string) => {
        if (options.trackFails) throw new Error("db down");
        log.tracked.push(taskId);
        return { ok: true, threadRef: "thread" };
      },
    },
    rounds: {
      startNudgeRun: async (_t: string, _task: string, text: string) => {
        if (options.roundFails) throw new Error("busy");
        log.rounds.push(text);
        return "started" as const;
      },
    },
    actorFor: async () => ({ id: "alice", role: "user" as const }),
    channels: {
      direct: async () =>
        ({ id: "chat", threadId: "t" }) as unknown as AgentChannel,
    },
    canClaim: async () => options.canClaim ?? true,
    quietUntil: async (_o, o) =>
      options.quiet && !o?.urgent ? new Date("2026-11-21T00:00:00Z") : null,
    gate: async () => options.gate ?? null,
    enabled: () => options.enabled ?? true,
    maxParallel: () => 2,
  });
  return { autonomy, log };
}

describe("领到之后", () => {
  test("开看板卡（执行人是这位员工、挂在它的单聊上）、当作一件活来跟、起一轮告诉它要做什么", async () => {
    const { autonomy, log } = fixture();
    expect(await autonomy.claimAndStart("alice", "bot")).toBe(2);
    expect(log.opened[0]).toMatchObject({
      tenantId: "alice",
      title: "活 1",
      executorAgentId: "bot",
      channelRef: "chat",
      triggerSource: "board_claim",
    });
    expect(log.tracked).toEqual(["task-1", "task-2"]);
    expect(log.started).toEqual(["card-1", "card-2"]);
    expect(log.rounds[0]).toContain("accept_task");
    expect(log.rounds[0]).toContain("活 1");
  });

  test("每次最多领到并行上限那么多张", async () => {
    const { autonomy, log } = fixture();
    await autonomy.claimAndStart("alice", "bot");
    expect(log.claims).toHaveLength(2);
  });

  test("这一轮起不来（线程忙）不算失败：卡已经在跟了，核对器会催", async () => {
    const { autonomy, log } = fixture({ roundFails: true });
    expect(await autonomy.claimAndStart("alice", "bot")).toBe(2);
    expect(log.released).toEqual([]);
    expect(log.tracked).toHaveLength(2);
  });

  test("开不出看板卡（额度用完）：放回去，别人或下一次再领，不再继续领", async () => {
    const { autonomy, log } = fixture({ openFails: true });
    expect(await autonomy.claimAndStart("alice", "bot")).toBe(0);
    expect(log.released).toEqual(["card-1"]);
    expect(log.claims).toHaveLength(1);
  });

  test("看板卡开出来了却没跟起来：这张卡放回去（连看板卡的记录一起丢），不卡在「已领」", async () => {
    const { autonomy, log } = fixture({ trackFails: true });
    expect(await autonomy.claimAndStart("alice", "bot")).toBe(0);
    expect(log.released).toEqual(["card-1:clear"]);
  });

  test("每次领之前先回收卡死在「已领」的卡", async () => {
    const { autonomy, log } = fixture();
    await autonomy.claimAndStart("alice", "bot");
    expect(log.recovered).toBe(1);
  });

  test("不能自己接活的员工（外部、被暂停、关了 accept_task）、功能关掉：一张都不领", async () => {
    for (const options of [{ canClaim: false }, { enabled: false }]) {
      const { autonomy, log } = fixture(options);
      expect(await autonomy.claimAndStart("alice", "bot")).toBe(0);
      expect(log.claims).toEqual([]);
    }
  });
});

describe("新卡放进来时踢一下", () => {
  test("同岗位开了心跳的员工现在就去领", async () => {
    const { autonomy, log } = fixture({
      employees: ["bot", "bot2"],
      cards: [card(1)],
    });
    expect(await autonomy.kick("alice", { role: "前端", urgent: false })).toBe(
      1,
    );
    // bot 领到一张后再看一眼（没有了），再轮到 bot2。
    expect(new Set(log.claims.map((claim) => claim.agent))).toEqual(
      new Set(["bot", "bot2"]),
    );
  });

  test("安静时段里普通卡不踢，留给心跳在时段结束后醒来领", async () => {
    const quiet = fixture({ quiet: true });
    expect(await quiet.autonomy.kick("alice", { role: "前端", urgent: false })).toBe(0);
    expect(quiet.log.claims).toEqual([]);
  });

  test("安静时段里紧急卡才踢，而且领的时候只领紧急的，不把前面的普通卡一起带走", async () => {
    const urgent = fixture({ quiet: true });
    expect(await urgent.autonomy.kick("alice", { role: "前端", urgent: true })).toBeGreaterThan(0);
    expect(urgent.log.claims.length).toBeGreaterThan(0);
    for (const claim of urgent.log.claims) expect(claim.onlyUrgent).toBe(true);
  });

  test("不在安静时段：不带 onlyUrgent，紧急不紧急都按优先级领", async () => {
    const awake = fixture();
    await awake.autonomy.kick("alice", { role: "前端", urgent: true });
    for (const claim of awake.log.claims) expect(claim.onlyUrgent).toBeUndefined();
  });

  test("本人关了主动检查、管理员关了、员工被暂停：新卡也不踢", async () => {
    const refused = fixture({ gate: "off_person" });
    expect(await refused.autonomy.kick("alice", { role: "前端", urgent: false })).toBe(0);
    expect(refused.log.claims).toEqual([]);
  });
});

describe("开关和话", () => {
  test("XIONGBAO_CARD_AUTOCLAIM 只认 off", () => {
    expect(cardAutoclaimOn({})).toBe(true);
    expect(cardAutoclaimOn({ XIONGBAO_CARD_AUTOCLAIM: "OFF" })).toBe(false);
    expect(cardAutoclaimOn({ XIONGBAO_CARD_AUTOCLAIM: "on" })).toBe(true);
  });
  test("给员工的话带标题和说明", () => {
    expect(cardAsk({ title: "改按钮", detail: "红色" })).toContain("红色");
  });
});

describe("看板卡的接口", () => {
  function app() {
    const created: unknown[] = [];
    const kicked: unknown[] = [];
    const cards = {
      create: async (input: unknown) => {
        created.push(input);
        return { id: "c1", role: "前端", urgent: false, ...(input as object) };
      },
      list: async () => [
        {
          id: "c1",
          status: "claimed",
          claimedBy: "bot",
          taskId: "t1",
          taskStatus: "running",
        },
      ],
      cancelOpen: async (id: string) => id === "open",
    } as unknown as BoardCardsStore;
    const routes = createBoardCardRoutes({
      cards,
      requireUser: async (context, next) => {
        context.set("actor", {
          id: "alice",
          email: "a@example.com",
          role: "user",
        });
        await next();
      },
      kick: async (owner, card) => {
        kicked.push([owner, card.role]);
      },
    });
    return {
      app: new Hono().route("/api/board-cards", routes),
      created,
      kicked,
    };
  }
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test("放一张卡：存下并踢一下同岗位的员工", async () => {
    const { app: a, created, kicked } = app();
    const response = await runAsTenant("alice", () =>
      a.request(
        "/api/board-cards",
        json("POST", { title: "改按钮", role: "前端", priority: 3 }),
      ),
    );
    expect(response.status).toBe(201);
    expect(created[0]).toMatchObject({
      title: "改按钮",
      role: "前端",
      priority: 3,
      createdBy: "alice",
    });
    await Promise.resolve();
    expect(kicked).toEqual([["alice", "前端"]]);
  });

  test("缺标题或岗位、优先级越界、多余的键：400", async () => {
    const { app: a, created } = app();
    for (const body of [
      { role: "前端" },
      { title: "x" },
      { title: "x", role: "y", priority: 101 },
      { title: "x", role: "y", claimedBy: "bot" },
    ])
      expect(
        (await a.request("/api/board-cards", json("POST", body))).status,
      ).toBe(400);
    expect(created).toEqual([]);
  });

  test("读：每张卡带谁领的、开出的看板卡和它的状态", async () => {
    const { app: a } = app();
    const body = (await (
      await runAsTenant("alice", () => a.request("/api/board-cards"))
    ).json()) as {
      cards: { claimedBy: string; taskId: string; taskStatus: string }[];
    };
    expect(body.cards[0]).toMatchObject({
      claimedBy: "bot",
      taskId: "t1",
      taskStatus: "running",
    });
  });

  test("撤一张没人领的卡；已被领走的 409", async () => {
    const { app: a } = app();
    expect(
      (
        await runAsTenant("alice", () =>
          a.request("/api/board-cards/open", json("DELETE")),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await runAsTenant("alice", () =>
          a.request("/api/board-cards/taken", json("DELETE")),
        )
      ).status,
    ).toBe(409);
  });
});
