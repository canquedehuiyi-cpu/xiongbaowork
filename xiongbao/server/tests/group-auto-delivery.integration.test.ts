import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  tasks,
  threadRunEvents,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { createDelivery } from "../src/tasks/delivery";
import { createEvidenceGate } from "../src/tasks/evidence-gate";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 群里 @ 员工派的活，员工做完没调用 `deliver_task` 时，这一轮结束卡自动进等验收，和看板派活（`channels/dispatch.ts`）
 * 用同一套收尾（`tasks/auto-delivery.ts`）：带上这件活写过的工作区文件，并先等这一轮最后一批事件写进库。
 * 真实 PostgreSQL、真实的群会话、看板和证据门；模型是假的，一轮「做什么」由测试写进这一轮的事件里。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const delivery = createDelivery(database);
const gate = createEvidenceGate(database);
const suite = randomUUID().slice(0, 8);
const prefix = `gad-${suite}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const createdAgents: string[] = [];
const createdChannels: string[] = [];
const tenants: string[] = [];
let counter = 0;

function write(path: string): BaseEvent[] {
  counter += 1;
  const toolCallId = `gad-call-${suite}-${counter}`;
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: "computer_write_file",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ path, contents: "x" }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `gad-result-${suite}-${counter}`,
      toolCallId,
      role: "tool",
      content: JSON.stringify({ ok: true, path }),
    },
  ] as unknown as BaseEvent[];
}

async function storeEvents(
  ownerId: string,
  threadId: string,
  agentId: string,
  runId: string,
  events: BaseEvent[],
  after = 0,
) {
  await runAsTenant(ownerId, async () => {
    await database
      .insert(threads)
      .values({ id: threadId, tenantId: ownerId, agentId })
      .onConflictDoNothing();
    await database
      .insert(threadRunEvents)
      .values(
        events.map((event, seq) => ({
          tenantId: ownerId,
          threadId,
          runId,
          seq: after + seq,
          event: event as unknown as Record<string, unknown>,
        })),
      )
      .onConflictDoNothing();
  });
}

async function setup(label: string) {
  const ownerId = `${prefix}-${label}`;
  const owner: AgentActor = { id: ownerId, role: "user" };
  tenants.push(ownerId);
  await runAsTenant(ownerId, () =>
    database
      .insert(users)
      .values({ id: ownerId, email: `${ownerId}@example.test` }),
  );
  return runAsTenant(ownerId, async () => {
    const make = async (name: string) => {
      const profile = await profileStore.create(owner, {
        name,
        title: "Tester",
        roleDescription: "Answer briefly.",
        visibility: "private",
      });
      createdAgents.push(profile.id);
      return profile.id;
    };
    const ada = await make("Ada");
    const grace = await make("Grace");
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    return { ownerId, owner, ada, grace, channel };
  });
}

/** A group whose Bots do `work` in their turn, and whose last events land `landsAfterMs` after it ends. */
function conversations(
  who: Awaited<ReturnType<typeof setup>>,
  work: (input: Parameters<TurnRunner>[0]) => Promise<void>,
  options: { wait?: boolean } = {},
) {
  let landed: Promise<void> = Promise.resolve();
  const service = createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: `${prefix}-replica-${who.ownerId}`,
    roster: async () => [
      { id: who.ada, name: "Ada" },
      { id: who.grace, name: "Grace" },
    ],
    runTurn: async (input) => {
      await work(input);
      return { replyText: "好了。" };
    },
    caps: { maxDepth: 0, maxPerRun: 2 },
    mayAddress: async () => false,
    auditStore: { insert: async () => undefined },
    progressEveryMs: 0,
    board: projector,
    delivery,
    workspaceFilesOf: (tenantId, runRef) =>
      gate.workspaceFilesOf({ tenantId, runRef }),
    ...(options.wait
      ? {
          eventsPersisted: async () => {
            await landed;
            return true;
          },
        }
      : {}),
  });
  return {
    service,
    /** Called by a turn that leaves its last events for later. */
    later: (write: () => Promise<void>) => {
      landed = new Promise<void>((resolve) =>
        setTimeout(() => void write().then(resolve), 150),
      );
    },
    drain: async () => {
      for (let i = 0; i < 10 && (await service.sweep()); i++) {}
      await landed;
    },
  };
}

const cardsOf = (ownerId: string, executor: string) =>
  runAsTenant(ownerId, () =>
    database
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.tenantId, ownerId), eq(tasks.executorAgentId, executor)),
      )
      .orderBy(asc(tasks.createdAt)),
  );

afterAll(async () => {
  try {
    await runAsTenant("platform", async () => {
      await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
      for (const id of createdChannels) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
      if (createdAgents.length) {
        await database
          .delete(agentProfiles)
          .where(inArray(agentProfiles.agentId, createdAgents));
        await database.delete(agents).where(inArray(agents.id, createdAgents));
      }
    });
    for (const id of tenants)
      await runAsTenant(id, async () => {
        await database
          .delete(threadRunEvents)
          .where(eq(threadRunEvents.tenantId, id));
        await database.delete(threads).where(eq(threads.tenantId, id));
        await database.delete(tasks).where(eq(tasks.tenantId, id));
        await database.delete(users).where(eq(users.id, id));
      });
  } catch {
    // A leftover row is another suite's noise, not this suite's failure.
  }
  await database.$client.close();
});

describe("群聊：漏交付时自动进等验收，带上这一轮写过的工作区文件", () => {
  test("写过文件、没调用 deliver_task：进等验收，带上文件，包括流结束后才写进库的最后一个", async () => {
    const who = await setup("files");
    const group = conversations(
      who,
      async (input) => {
        const runId = input.runId ?? "";
        const thread = input.threadId ?? "";
        await storeEvents(who.ownerId, thread, input.agentId, runId, [
          ...write("actions.csv"),
          ...write("../escape.md"),
        ]);
        group.later(() =>
          storeEvents(
            who.ownerId,
            thread,
            input.agentId,
            runId,
            write("drafts/last.md"),
            1000,
          ),
        );
      },
      { wait: true },
    );
    await runAsTenant(who.ownerId, () =>
      group.service.send(who.ownerId, who.channel.id, {
        id: `${prefix}-m1`,
        text: "@Ada 整理会议纪要",
      }),
    );
    await runAsTenant("platform", () => group.drain());
    const [card] = await cardsOf(who.ownerId, who.ada);
    expect(card?.status).toBe("awaiting_review");
    expect(card?.tracked).toBe(false);
    expect(card?.deliverableRef).toEqual({
      kind: "deliverable",
      workspaceFiles: ["actions.csv", "drafts/last.md"],
    });
  });

  test("没写过文件：照旧，没有交付物", async () => {
    const who = await setup("nothing");
    const group = conversations(who, async () => {});
    await runAsTenant(who.ownerId, () =>
      group.service.send(who.ownerId, who.channel.id, {
        id: `${prefix}-m2`,
        text: "@Ada 你好",
      }),
    );
    await runAsTenant("platform", () => group.drain());
    const [card] = await cardsOf(who.ownerId, who.ada);
    expect(card?.status).toBe("awaiting_review");
    expect(card?.deliverableRef).toBeNull();
  });

  test("在跟的卡（已接下、已交付）：交付物原样不动", async () => {
    const who = await setup("tracked");
    const handed = {
      kind: "deliverable" as const,
      notes: ["结论：三条风险"],
      checks: ["核对了合同"],
    };
    const group = conversations(who, async (input) => {
      const runId = input.runId ?? "";
      await storeEvents(
        who.ownerId,
        input.threadId ?? "",
        input.agentId,
        runId,
        write("extra/not-listed.md"),
      );
      const [card] = await runAsTenant(who.ownerId, () =>
        database
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.tenantId, who.ownerId), eq(tasks.runRef, runId))),
      );
      if (!card) throw new Error("the turn opened no card");
      // `accept_task` then `deliver_task`, in the turn.
      await delivery.markTracked(
        who.ownerId,
        card.id,
        `agent:${input.agentId}`,
      );
      await runAsTenant(who.ownerId, () =>
        database
          .update(tasks)
          .set({ acceptedAt: new Date(), activeRunRef: runId })
          .where(eq(tasks.id, card.id)),
      );
      await delivery.delivered(who.ownerId, card.id, {
        runId,
        agentId: input.agentId,
        actor: `agent:${input.agentId}`,
        deliverable: handed,
      });
    });
    await runAsTenant(who.ownerId, () =>
      group.service.send(who.ownerId, who.channel.id, {
        id: `${prefix}-m3`,
        text: "@Ada 审合同",
      }),
    );
    await runAsTenant("platform", () => group.drain());
    const [card] = await cardsOf(who.ownerId, who.ada);
    expect(card?.tracked).toBe(true);
    expect(card?.status).toBe("awaiting_review");
    expect(card?.deliverableRef).toEqual(handed);
  });
});
