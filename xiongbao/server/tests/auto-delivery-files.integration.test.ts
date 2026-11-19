import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import {
  CHANNEL_DISPATCH_KIND,
  createChannelDispatch,
  dispatchRunId,
} from "../src/channels/dispatch";
import { createDatabase } from "../src/db/client";
import {
  tasks,
  threadRunEvents,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import type { TurnRunner } from "../src/routines/runner";
import { createDelivery } from "../src/tasks/delivery";
import {
  AUTO_DELIVERY_FILE_LIMIT,
  createEvidenceGate,
} from "../src/tasks/evidence-gate";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 员工做完活没调用 `deliver_task`，看板派活的那一轮结束时卡自动进等验收（`tasks/projector.ts` 的 `finished`，
 * 由 `channels/dispatch.ts` 收尾时调用）。这一次它把这件活各轮里员工成功写过、改过的工作区文件带上，当作
 * `deliverableRef.workspaceFiles`，验收的人才看得到产物。真实 PostgreSQL（NOBYPASSRLS 应用角色），真实的
 * 派活、看板、证据门；只有模型是假的：一轮「做什么」由测试写进这一轮的事件里。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const projector = createTaskProjector(database);
const delivery = createDelivery(database);
const gate = createEvidenceGate(database);
const queue = createWorkQueue(database);

const owner: AgentActor = { id: `adf-owner-${suite}`, role: "user" };
const agentId = `adf-agent-${suite}`;
const channelId = `adf-channel-${suite}`;
const threadId = `adf-thread-${suite}`;
const seededKeys: string[] = [];
let counter = 0;

/** What the stand-in model does in a turn: the events it streamed, and what it says at the end. */
type Script = (runId: string) => BaseEvent[];

let script: Script = () => [];
let afterTurn: ((runId: string) => Promise<void>) | undefined;

const service = createChannelDispatch({
  queue,
  owner: `adf-${suite}`,
  board: projector,
  channel: async (actor) =>
    actor.id === owner.id
      ? { id: channelId, threadId, agentIds: ["pinned"] }
      : null,
  bot: async (actor, id) =>
    actor.id === owner.id && id === agentId ? { id, name: "小熊" } : null,
  actorFor: async (id) => ({ id, role: "user" }),
  runTurn: (async (input) => {
    const runId = input.runId ?? "";
    await storeEvents(runId, script(runId));
    await afterTurn?.(runId);
    return { replyText: "做完了。" };
  }) as TurnRunner,
  workspaceFilesOf: (tenantId, runRef) =>
    gate.workspaceFilesOf({ tenantId, runRef }),
});

async function storeEvents(runId: string, events: BaseEvent[]) {
  await storeEventsAfter(runId, events, 0);
}

/** Append events to a run's stored ones, after the `after` rows it already has. */
async function storeEventsAfter(
  runId: string,
  events: BaseEvent[],
  after: number,
) {
  if (events.length === 0) return;
  await runAsTenant(owner.id, async () => {
    await database
      .insert(threadRunEvents)
      .values(
        events.map((event, seq) => ({
          tenantId: owner.id,
          threadId,
          runId,
          seq: after + seq,
          event: event as unknown as Record<string, unknown>,
        })),
      )
      .onConflictDoNothing();
  });
}

function call(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): BaseEvent[] {
  counter += 1;
  const toolCallId = `adf-call-${suite}-${counter}`;
  return [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `adf-result-${suite}-${counter}`,
      toolCallId,
      role: "tool",
      content: JSON.stringify(result),
    },
  ] as unknown as BaseEvent[];
}

const write = (path: string) =>
  call("computer_write_file", { path, contents: "x" }, { ok: true, path });
const edit = (path: string) =>
  call(
    "computer_edit_file",
    { path, old_string: "a", new_string: "b" },
    { ok: true, path, edited: true },
  );

/** One dispatch, from the request to the end of its turn: the card as the board then shows it. */
async function dispatch(
  label: string,
  doing: Script,
  between?: (runId: string) => Promise<void>,
) {
  script = doing;
  afterTurn = between;
  const id = `${label}-${suite}`;
  const runId = dispatchRunId(owner.id, channelId, id);
  seededKeys.push(runId);
  await runAsTenant(owner.id, () =>
    service.submit(owner, channelId, {
      id,
      agentId,
      text: `做 ${label}`,
    }),
  );
  for (let round = 0; round < 20; round += 1) {
    if (!(await runAsTenant("platform", () => service.sweep()))) break;
    const [card] = await cardOf(runId);
    if (card && card.status !== "running") break;
  }
  const [card] = await cardOf(runId);
  if (!card) throw new Error("the dispatch opened no card");
  return { runId, card };
}

const cardOf = (runId: string) =>
  runAsTenant(owner.id, () =>
    database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, owner.id), eq(tasks.runRef, runId))),
  );

beforeAll(async () => {
  await runAsTenant(owner.id, async () => {
    await database
      .insert(users)
      .values({ id: owner.id, email: `${owner.id}@example.test` });
    await database
      .insert(threads)
      .values({ id: threadId, tenantId: owner.id, agentId });
  });
});

afterAll(async () => {
  const quietly = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch {
      // A leftover row is another suite's noise, not this suite's failure.
    }
  };
  await quietly(() =>
    runAsTenant(owner.id, async () => {
      await database
        .delete(threadRunEvents)
        .where(eq(threadRunEvents.threadId, threadId));
      await database.delete(threads).where(eq(threads.id, threadId));
      await database.delete(tasks).where(eq(tasks.tenantId, owner.id));
      if (seededKeys.length > 0)
        await database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, CHANNEL_DISPATCH_KIND),
              inArray(workItems.key, seededKeys),
            ),
          );
      await database.delete(users).where(eq(users.id, owner.id));
    }),
  );
  await database.$client.close();
});

describe("漏交付时自动进等验收，带上这一轮写过的工作区文件", () => {
  test("写过文件、没调用 deliver_task：进等验收，workspaceFiles 是这些文件", async () => {
    const { card } = await dispatch("files", () => [
      ...call("computer_read_file", { path: "input.md" }, { ok: true }),
      ...write("actions.csv"),
      ...write("drafts/李明.md"),
      ...edit("drafts/李明.md"),
      ...write("drafts/王芳.md"),
      ...call("computer_run_command", { command: "ls" }, { ok: true }),
    ]);
    expect(card.status).toBe("awaiting_review");
    expect(card.tracked).toBe(false);
    expect(card.deliverableRef).toEqual({
      kind: "deliverable",
      workspaceFiles: ["actions.csv", "drafts/李明.md", "drafts/王芳.md"],
    });
  });

  test("工作区外的路径、绝对路径、失败的写入不算", async () => {
    const { card } = await dispatch("outside", () => [
      ...write("/etc/hosts"),
      ...write("../escape.md"),
      ...write("~/home.md"),
      ...write("C:\\x\\y.md"),
      ...call(
        "computer_write_file",
        { path: "failed.md", contents: "x" },
        { ok: false, error: "disk full" },
      ),
      ...write("inside/ok.md"),
    ]);
    expect(card.status).toBe("awaiting_review");
    expect(card.deliverableRef).toEqual({
      kind: "deliverable",
      workspaceFiles: ["inside/ok.md"],
    });
  });

  test("别的活的文件不带进来：同一段对话里另一件活写的、同一个员工别的轮写的，都不算", async () => {
    const other = await dispatch("other-card", () => [
      ...write("others/secret.md"),
    ]);
    // A stray round of this thread that belongs to no card of this person's work.
    await storeEvents(`stray-${suite}`, write("stray/unrelated.md"));
    const mine = await dispatch("mine", () => write("mine/report.md"));
    expect(other.card.deliverableRef).toEqual({
      kind: "deliverable",
      workspaceFiles: ["others/secret.md"],
    });
    expect(mine.card.deliverableRef).toEqual({
      kind: "deliverable",
      workspaceFiles: ["mine/report.md"],
    });
  });

  test("一件活的各轮：这张卡名下每一轮写过的文件合在一起，去重", async () => {
    const earlier = `earlier-${suite}`;
    await storeEvents(earlier, [
      ...write("round1/a.md"),
      ...write("shared.md"),
    ]);
    const { card } = await dispatch(
      "rounds",
      () => [...write("shared.md"), ...write("round2/b.md")],
      async (runId) => {
        // The card's earlier round is named by its history, as every round of a card is.
        await runAsTenant(owner.id, async () => {
          const [row] = await database
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.tenantId, owner.id), eq(tasks.runRef, runId)));
          if (!row) throw new Error("no card");
          const { appendTaskEvent } = await import("../src/tasks/events");
          await appendTaskEvent(database, {
            tenantId: owner.id,
            taskId: row.id,
            kind: "run_ended",
            actor: "system",
            detail: { runId: earlier },
          });
        });
      },
    );
    const ref = card.deliverableRef as {
      kind: string;
      workspaceFiles: string[];
    };
    expect(ref.kind).toBe("deliverable");
    // Each file once, whichever round wrote it; the order of the rounds is not promised.
    expect([...ref.workspaceFiles].sort()).toEqual([
      "round1/a.md",
      "round2/b.md",
      "shared.md",
    ]);
  });

  test("超过上限时截断", async () => {
    const { card } = await dispatch("many", () =>
      Array.from({ length: AUTO_DELIVERY_FILE_LIMIT + 7 }, (_, i) =>
        write(`out/${String(i).padStart(2, "0")}.md`),
      ).flat(),
    );
    const ref = card.deliverableRef as { workspaceFiles: string[] };
    expect(card.status).toBe("awaiting_review");
    expect(ref.workspaceFiles).toHaveLength(AUTO_DELIVERY_FILE_LIMIT);
    expect(ref.workspaceFiles[0]).toBe("out/00.md");
  });

  test("没写过文件：卡照旧进等验收，没有交付物", async () => {
    const { card } = await dispatch("nothing", () => [
      ...call("computer_read_file", { path: "input.md" }, { ok: true }),
      ...call("computer_list_files", { path: "." }, { ok: true }),
    ]);
    expect(card.status).toBe("awaiting_review");
    expect(card.deliverableRef).toBeNull();
  });

  test("一轮失败：卡失败，不带文件", async () => {
    script = () => write("half.md");
    const failing = createChannelDispatch({
      queue,
      owner: `adf-fail-${suite}`,
      board: projector,
      channel: async () => ({ id: channelId, threadId, agentIds: ["pinned"] }),
      bot: async (_actor, id) => ({ id, name: "小熊" }),
      actorFor: async (id) => ({ id, role: "user" }),
      runTurn: (async (input) => {
        await storeEvents(input.runId ?? "", write("half.md"));
        throw new Error("model down");
      }) as TurnRunner,
      workspaceFilesOf: (tenantId, runRef) =>
        gate.workspaceFilesOf({ tenantId, runRef }),
    });
    const id = `failing-${suite}`;
    const runId = dispatchRunId(owner.id, channelId, id);
    seededKeys.push(runId);
    await runAsTenant(owner.id, () =>
      failing.submit(owner, channelId, { id, agentId, text: "会失败的活" }),
    );
    await runAsTenant("platform", () => failing.sweep());
    const [card] = await cardOf(runId);
    expect(card?.status).toBe("failed");
    expect(card?.deliverableRef).toBeNull();
  });

  test("已经调用过 deliver_task 的：交付物原样不动，不会再并进写过的文件", async () => {
    const handed = {
      kind: "deliverable" as const,
      notes: ["结论：三条风险"],
      checks: ["核对了合同"],
    };
    const { card } = await dispatch(
      "delivered",
      () => write("extra/not-listed.md"),
      async (runId) => {
        // The coworker took the work on and handed it in during the turn.
        await runAsTenant(owner.id, async () => {
          const [row] = await database
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.tenantId, owner.id), eq(tasks.runRef, runId)));
          if (!row) throw new Error("no card");
          await database
            .update(tasks)
            .set({
              tracked: true,
              acceptedAt: new Date(),
              executorAgentId: agentId,
              activeRunRef: runId,
            })
            .where(eq(tasks.id, row.id));
          await delivery.delivered(owner.id, row.id, {
            runId,
            agentId,
            actor: `agent:${agentId}`,
            deliverable: handed,
          });
        });
      },
    );
    expect(card.status).toBe("awaiting_review");
    expect(card.tracked).toBe(true);
    expect(card.deliverableRef).toEqual(handed);
  });

  test("读不到文件证据时：卡照旧进等验收，只是不带文件", async () => {
    const broken = createChannelDispatch({
      queue,
      owner: `adf-broken-${suite}`,
      board: projector,
      channel: async () => ({ id: channelId, threadId, agentIds: ["pinned"] }),
      bot: async (_actor, id) => ({ id, name: "小熊" }),
      actorFor: async (id) => ({ id, role: "user" }),
      runTurn: (async () => ({ replyText: "好了" })) as TurnRunner,
      workspaceFilesOf: async () => {
        throw new Error("events unreadable");
      },
    });
    const id = `broken-${suite}`;
    const runId = dispatchRunId(owner.id, channelId, id);
    seededKeys.push(runId);
    await runAsTenant(owner.id, () =>
      broken.submit(owner, channelId, { id, agentId, text: "读不到证据的活" }),
    );
    await runAsTenant("platform", () => broken.sweep());
    const [card] = await cardOf(runId);
    expect(card?.status).toBe("awaiting_review");
    expect(card?.deliverableRef).toBeNull();
  });

  /*
   * 一轮的流结束后，最后一批事件才写进库。收尾读事件之前要等它写完，否则最后一个写文件的调用就漏了。
   */
  describe("最后一批事件在流结束后才写入", () => {
    /** A dispatch whose turn ends with its last write call still on its way to the database. */
    async function late(
      label: string,
      reader: {
        eventsPersisted?: (runId: string) => Promise<boolean>;
      },
      landsAfterMs = 150,
    ) {
      let landed: Promise<void> = Promise.resolve();
      const lateService = createChannelDispatch({
        queue,
        owner: `adf-late-${label}-${suite}`,
        board: projector,
        channel: async () => ({
          id: channelId,
          threadId,
          agentIds: ["pinned"],
        }),
        bot: async (_actor, id) => ({ id, name: "小熊" }),
        actorFor: async (id) => ({ id, role: "user" }),
        runTurn: (async (input) => {
          const runId = input.runId ?? "";
          await storeEvents(runId, write("early.md"));
          // The stream has ended when this returns; the last call is written a moment later.
          landed = new Promise<void>((resolve) =>
            setTimeout(() => {
              void storeEventsAfter(runId, write("last.md"), 1000).then(
                resolve,
              );
            }, landsAfterMs),
          );
          return { replyText: "做完了。" };
        }) as TurnRunner,
        workspaceFilesOf: (tenantId, runRef) =>
          gate.workspaceFilesOf({ tenantId, runRef }),
        ...(reader.eventsPersisted
          ? {
              eventsPersisted: async (runId: string) => {
                const given = reader.eventsPersisted;
                if (!given) return true;
                const settled = await given(runId);
                await landed;
                return settled;
              },
            }
          : {}),
      });
      const id = `late-${label}-${suite}`;
      const runId = dispatchRunId(owner.id, channelId, id);
      seededKeys.push(runId);
      await runAsTenant(owner.id, () =>
        lateService.submit(owner, channelId, { id, agentId, text: "最后才写" }),
      );
      await runAsTenant("platform", () => lateService.sweep());
      await landed;
      const [card] = await cardOf(runId);
      return card;
    }

    test("没有等的话最后一个写文件的调用会漏（对照）", async () => {
      const card = await late("control", {});
      expect(card?.deliverableRef).toEqual({
        kind: "deliverable",
        workspaceFiles: ["early.md"],
      });
    });

    test("收尾先等这一轮的事件写完，拿得到最后一个写文件的调用", async () => {
      const card = await late("wait", { eventsPersisted: async () => true });
      expect(card?.status).toBe("awaiting_review");
      expect(card?.deliverableRef).toEqual({
        kind: "deliverable",
        workspaceFiles: ["early.md", "last.md"],
      });
    });

    test("等不到（超时）：照现在的做法读已有的，并记日志", async () => {
      const logged: string[] = [];
      const quiet = spyOn(console, "error").mockImplementation(
        (line: unknown) => {
          logged.push(String(line));
        },
      );
      let card: Awaited<ReturnType<typeof late>>;
      try {
        card = await late("timeout", { eventsPersisted: async () => false });
      } finally {
        quiet.mockRestore();
      }
      expect(card?.status).toBe("awaiting_review");
      expect(card?.deliverableRef).toMatchObject({ kind: "deliverable" });
      expect(
        logged.some((line) => line.includes("auto-delivery-events-late")),
      ).toBe(true);
    });
  });
});
