import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { eq, inArray, like } from "drizzle-orm";
import {
  createAcpGroupTurn,
  createAcpTurnStarter,
  DeviceAcpAgent,
  type DeviceAcpEmployee,
  routeExternalTurns,
} from "../src/agents/acp/agent";
import { createAcpRelay } from "../src/agents/acp/relay";
import type { AcpTurnRow } from "../src/agents/acp/turns";
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
  groupMessages,
  intelligenceChannelMappings,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { createWorkQueue } from "../src/work/queue";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 群聊里的外部员工（agent.ts `createAcpGroupTurn`）：群聊不等它——轮次排进它自己的群聊线程，群里先答
 * 「开始干了」，等它的轮次（真 relay + 假设备通道 + 真 PostgresAgentRunner）跑完再把回答贴进群里。
 * 它在等许可时，别的群、同群的内置员工照常答话。
 */

type Frame = Record<string, unknown>;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const prefix = `acp-group-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
    for (const id of createdChannels.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    for (const id of createdUsers.splice(0)) {
      await runAsTenant(id, async () => {
        await database.delete(tasks).where(eq(tasks.tenantId, id));
        await database
          .delete(threadRunEvents)
          .where(eq(threadRunEvents.tenantId, id));
        await database.delete(threadRuns).where(eq(threadRuns.tenantId, id));
        await database.delete(threads).where(eq(threads.tenantId, id));
      });
      await database.delete(users).where(eq(users.id, id));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Group Test" }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

async function bot(owner: AgentActor, name: string) {
  const profile = await runAsTenant(owner.id, () =>
    profileStore.create(owner, {
      name,
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    }),
  );
  createdAgents.push(profile.id);
  return profile.id;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an external employee in a group", () => {
  test("answers into the group without holding the group's sweep, while others answer as usual", async () => {
    const owner = await person();
    const external = await bot(owner, "小码");
    const writer = await bot(owner, "Writer");
    const reviewer = await bot(owner, "Reviewer");
    // Hired from a computer: what Task 8 writes for an external employee.
    await runAsTenant("platform", () =>
      database
        .update(agents)
        .set({
          type: "device_acp",
          configuration: {
            deviceId: "laptop",
            harness: "codex",
            workdirRef: "fld_work",
          },
        })
        .where(eq(agents.id, external)),
    );
    const employee: DeviceAcpEmployee = {
      id: external,
      name: "小码",
      ownerUserId: owner.id,
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
      persona: "",
    };

    const turns = createMemoryAcpTurnStore();
    const down: Frame[] = [];
    const target = { tenantId: owner.id, deviceId: "laptop" };
    let startQueuedTurn: ((row: AcpTurnRow) => Promise<void>) | undefined;
    const relay = createAcpRelay({
      channel: {
        notify: (_target, frame) => {
          down.push(frame);
          return true;
        },
        isReachable: () => true,
        connectionOf: () => "conn-1",
      },
      turns,
      startQueuedTurn: async (row) => {
        if (!startQueuedTurn) throw new Error("not yet");
        await startQueuedTurn(row);
      },
      log: () => undefined,
    });
    const projector = createTaskProjector(database);
    const runner = new PostgresAgentRunner(database, projector);
    const builtIn: string[] = [];
    const normal: TurnRunner = async (input) => {
      builtIn.push(input.agentId);
      return {
        replyText: `${input.agentId === writer ? "Writer" : "Reviewer"} 看过了。`,
      };
    };
    const conversations = createGroupConversations({
      store: createGroupStore(database, () => threadIdentity.mint()),
      queue: createWorkQueue(database),
      owner: `${prefix}-replica`,
      roster: async (ownerUserId, channelId) => {
        const actor: AgentActor = { id: ownerUserId, role: "user" };
        const channel = await channelStore.get(actor, channelId);
        if (!channel || channel.agentIds.length < 2) return null;
        const bots = [];
        for (const agentId of channel.agentIds) {
          const profile = await profileStore.get(actor, agentId);
          if (profile) bots.push({ id: agentId, name: profile.name });
        }
        return bots;
      },
      runTurn: routeExternalTurns({
        isExternal: async (agentId) => agentId === external,
        normal,
        external: createAcpGroupTurn({
          turns,
          relay,
          channel: { isReachable: () => true },
          employeeFor: async (agentId) =>
            agentId === external ? employee : null,
          log: () => undefined,
        }),
      }),
      caps: { maxDepth: 1, maxPerRun: 2 },
      mayAddress: async () => true,
      auditStore: { insert: async () => undefined },
      progressEveryMs: 0,
      board: projector,
    });
    startQueuedTurn = createAcpTurnStarter({
      database,
      turns,
      runner,
      employeeFor: async () => employee,
      agentFor: (_employee, row) =>
        new DeviceAcpAgent({
          agentId: external,
          ownerUserId: owner.id,
          tenantId: row.tenantId,
          deviceId: "laptop",
          harness: "codex",
          workdirRef: "fld_work",
          name: "小码",
          relay,
          turns,
          reachable: () => true,
          context: async () => [],
          claimed: row,
          every: () => () => undefined,
          log: () => undefined,
        }),
      announce: ({ threadId, agentId, ownerUserId, text }) =>
        conversations
          .announceHandoff({
            threadId,
            actorId: ownerUserId,
            agentId,
            text,
            via: "device_acp",
          })
          .then(() => undefined),
      log: () => undefined,
    });
    const from = { ...target, connectionId: "conn-1" };
    const device = async (frame: Frame) => {
      relay.fromRunner(from, { agentId: external, ...frame });
      await relay.drain(from);
    };
    const sweepAll = async () => {
      for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
    };

    const groupA = await runAsTenant(owner.id, () =>
      channelStore.create(owner, [external, writer]),
    );
    const groupB = await runAsTenant(owner.id, () =>
      channelStore.create(owner, [writer, reviewer]),
    );
    createdChannels.push(groupA.id, groupB.id);
    const list = (channelId: string) =>
      runAsTenant(owner.id, () => conversations.list(owner.id, channelId));

    // Group A: both employees are asked. The sweep is over before the computer has said anything.
    await runAsTenant(owner.id, () =>
      conversations.send(owner.id, groupA.id, {
        id: `${prefix}-a1`,
        text: "请检查一下登录页",
      }),
    );
    await sweepAll();
    const afterSweep = (await list(groupA.id)).messages;
    expect(afterSweep.map((message) => message.text)).toContain(
      "小码开始干这件活了，做完会在群里回复。",
    );
    expect(builtIn).toEqual([writer]);
    expect(turns.rows).toHaveLength(1);
    const turn = turns.rows[0] as AcpTurnRow;
    // Its lane is its own group thread; the prompt is the group's framed message.
    expect(turn.agentId).toBe(external);
    const prompt = turn.prompt as {
      content: { text: string }[];
      runRef: string;
    };
    expect(prompt.content[0]?.text).toContain("请检查一下登录页");

    // The relay starts it on the computer; it stops to ask for permission.
    await until(
      () => down.some((frame) => frame.type === "acp.open"),
      "acp.open",
    );
    await device({
      type: "acp.session",
      threadId: turn.threadId,
      sessionId: "s",
      loaded: true,
    });
    await until(
      () => down.some((frame) => frame.type === "acp.prompt"),
      "acp.prompt",
    );
    await device({
      type: "acp.turn.ack",
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    await device({
      type: "acp.permission.request",
      threadId: turn.threadId,
      turnId: turn.turnId,
      requestId: "req-1",
      toolCall: { toolCallId: "c", kind: "execute", title: "git push" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      facts: { insideWorkdir: true, paths: [] },
    });
    expect(turns.rows[0]?.status).toBe("awaiting");
    // Its card stays open while it works.
    const card = async () =>
      (
        await runAsTenant(owner.id, () =>
          database
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.runRef, prompt.runRef)),
        )
      )[0]?.status;
    expect(await card()).toBe("running");

    // Meanwhile group B, and group A's built-in employee, answer as usual.
    await runAsTenant(owner.id, () =>
      conversations.send(owner.id, groupB.id, {
        id: `${prefix}-b1`,
        text: "两位看看文案",
      }),
    );
    await runAsTenant(owner.id, () =>
      conversations.send(owner.id, groupA.id, {
        id: `${prefix}-a2`,
        text: "@Writer 你也看看",
      }),
    );
    await sweepAll();
    // A group answers in its roster's order; which of B's two goes first is not this test's.
    expect(builtIn.slice(1).sort()).toEqual([writer, writer, reviewer].sort());
    expect(
      (await list(groupB.id)).messages.filter(
        (message) => message.agentId && message.status === "completed",
      ),
    ).toHaveLength(2);

    // The owner says yes; the employee finishes, and its answer lands in group A, in its own name.
    await device({
      type: "acp.update",
      threadId: turn.threadId,
      turnId: turn.turnId,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "登录页检查完了，已推送。" },
      },
    });
    await device({
      type: "acp.turn.end",
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason: "end_turn",
      interrupted: false,
    });
    await until(
      async () =>
        (await list(groupA.id)).messages.some(
          (message) => message.text === "登录页检查完了，已推送。",
        ),
      "the answer in the group",
    );
    const answer = (await list(groupA.id)).messages.find(
      (message) => message.text === "登录页检查完了，已推送。",
    ) as Record<string, unknown>;
    expect(answer.agentId).toBe(external);
    expect(answer.answeredBy).toBe(external);
    // Its own answer, not a relayed one.
    const [stored] = await runAsTenant(owner.id, () =>
      database
        .select({ details: groupMessages.details })
        .from(groupMessages)
        .where(eq(groupMessages.text, "登录页检查完了，已推送。")),
    );
    expect(stored?.details).toMatchObject({
      via: "device_acp",
      answeredBy: external,
    });
    await until(
      async () => (await card()) === "awaiting_review",
      "the card to close",
    );
  });
});
