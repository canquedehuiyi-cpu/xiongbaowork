import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { eq, inArray, like } from "drizzle-orm";
import {
  type AcpPermissionRequest,
  createAcpGroupTurn,
  createAcpTurnStarter,
  DeviceAcpAgent,
  type DeviceAcpEmployee,
  routeExternalTurns,
} from "../src/agents/acp/agent";
import { externalEmployeesAmong } from "../src/agents/acp/external";
import { createAcpRelay } from "../src/agents/acp/relay";
import type { AcpTurnRow } from "../src/agents/acp/turns";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createGroupRoster } from "../src/channels/group-roster";
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
  usageCounters,
  users,
  workItems,
} from "../src/db/schema";
import {
  type CheckPrivateShare,
  createPrivateShareCheck,
} from "../src/proactive/private-share";
import { createQuotaService } from "../src/quota/limits";
import { createTaskProjector } from "../src/tasks/projector";
import { currentTenant, runAsTenant } from "../src/tenant/context";
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
const quota = createQuotaService(database);
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
        await database
          .delete(usageCounters)
          .where(eq(usageCounters.tenantId, id));
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

/** A hirer's external employee and two built-in employees, the group service and a computer. */
async function harness(
  owner: AgentActor,
  options: { privateShare?: CheckPrivateShare } = {},
) {
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

  const permissions: AcpPermissionRequest[] = [];
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
  // Charging the plan as production does, so a second card would show as a second charge.
  const projector = createTaskProjector(database, undefined, quota);
  const runner = new PostgresAgentRunner(database, projector);
  const builtIn: string[] = [];
  const normal: TurnRunner = async (input) => {
    builtIn.push(input.agentId);
    return {
      replyText: `${input.agentId === writer ? "Writer" : "Reviewer"} 看过了。`,
    };
  };
  const groupStore = createGroupStore(database, () => threadIdentity.mint());
  const conversations = createGroupConversations({
    store: groupStore,
    queue: createWorkQueue(database),
    owner: `${prefix}-replica`,
    // The roster production uses: the hirer's external employee is every member's in this group.
    roster: createGroupRoster({
      actorFor: async (id) => ({ id, role: "user" }),
      channel: (actor, channelId) => channelStore.get(actor, channelId),
      profile: (actor, agentId) => profileStore.get(actor, agentId),
      externalEmployees: (agentIds) =>
        externalEmployeesAmong(database, agentIds),
      members: (channelId) => groupStore.members(channelId),
    }),
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
    ...(options.privateShare ? { privateShare: options.privateShare } : {}),
    mayAddress: async () => true,
    auditStore: { insert: async () => undefined },
    progressEveryMs: 0,
    board: projector,
    createChannel: async (ownerUserId, agentIds, options) => {
      const made = await channelStore.create(
        { id: ownerUserId, role: "user" },
        agentIds,
        options,
      );
      return made;
    },
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
        onPermission: (request) => permissions.push(request),
        log: () => undefined,
      }),
    // As index.ts announces it: into the group thread's owner's frame, whoever that is.
    announce: ({ threadId, agentId, text }) =>
      conversations
        .announceExternal({ threadId, agentId, text })
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

  const list = (channelId: string, reader: AgentActor = owner) =>
    runAsTenant(reader.id, () => conversations.list(reader.id, channelId));
  return {
    builtIn,
    external,
    writer,
    reviewer,
    turns,
    down,
    permissions,
    projector,
    conversations,
    device,
    sweepAll,
    list,
  };
}

describe("an external employee in a group", () => {
  test("answers into the group without holding the group's sweep, while others answer as usual", async () => {
    const owner = await person();
    const {
      builtIn,
      external,
      writer,
      reviewer,
      turns,
      down,
      permissions,
      conversations,
      device,
      sweepAll,
      list,
    } = await harness(owner);
    const groupA = await runAsTenant(owner.id, () =>
      channelStore.create(owner, [external, writer]),
    );
    const groupB = await runAsTenant(owner.id, () =>
      channelStore.create(owner, [writer, reviewer]),
    );
    createdChannels.push(groupA.id, groupB.id);

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
    // The request names the one card this work has, where its approval parks (Task 7).
    const cards = () =>
      runAsTenant(owner.id, () =>
        database
          .select({ runRef: tasks.runRef, status: tasks.status })
          .from(tasks)
          .where(eq(tasks.executorAgentId, external)),
      );
    expect(permissions.map((request) => request.runRef)).toEqual([
      prompt.runRef,
    ]);
    expect((await cards()).map((card) => card.runRef)).toEqual([prompt.runRef]);
    const card = async () => (await cards())[0]?.status;

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

  test("asked by another member of the group, it works in its hirer's queue and answers into the group", async () => {
    const owner = await person();
    const teammate = await person();
    const {
      external,
      writer,
      turns,
      down,
      permissions,
      conversations,
      device,
      sweepAll,
      list,
    } = await harness(owner);
    const channel = await runAsTenant(owner.id, () =>
      conversations.create(owner.id, { agentIds: [external, writer] }),
    );
    createdChannels.push(channel.id);
    const [{ email } = { email: "" }] = await runAsTenant(teammate.id, () =>
      database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, teammate.id)),
    );
    await runAsTenant(owner.id, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );

    const tasksUsed = async (tenant: string) =>
      (await quota.usageFor(tenant)).tasks;
    const [hirerBefore, teammateBefore] = [
      await tasksUsed(owner.id),
      await tasksUsed(teammate.id),
    ];
    await runAsTenant(teammate.id, () =>
      conversations.send(teammate.id, channel.id, {
        id: `${prefix}-t1`,
        text: "@小码 帮我看下构建为什么失败",
      }),
    );
    await sweepAll();
    /*
     * One piece of work, one card: in its hirer's tenant, where its turn runs and the run that does
     * the work finishes it, and charged once there. Nothing lands on the teammate's board or plan.
     */
    const cards = () =>
      runAsTenant("platform", () =>
        database
          .select({
            tenantId: tasks.tenantId,
            runRef: tasks.runRef,
            status: tasks.status,
          })
          .from(tasks)
          .where(eq(tasks.executorAgentId, external)),
      );
    expect((await cards()).map((card) => card.tenantId)).toEqual([owner.id]);
    expect(
      (await list(channel.id, teammate)).messages.map(
        (message) => message.text,
      ),
    ).toContain("小码开始干这件活了，做完会在群里回复。");
    // Queued in its hirer's tenant, where its computer is: the relay claims it.
    expect(turns.rows).toHaveLength(1);
    const turn = turns.rows[0] as AcpTurnRow;
    expect(turn.tenantId).toBe(owner.id);
    const { runRef } = turn.prompt as { runRef: string };
    expect((await cards())[0]?.runRef).toBe(runRef);
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
    expect(turns.rows[0]?.status).toBe("sent");
    await device({
      type: "acp.turn.ack",
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    // Its permission requests go to its hirer (Task 7 decides who may answer).
    await device({
      type: "acp.permission.request",
      threadId: turn.threadId,
      turnId: turn.turnId,
      requestId: "req-t",
      toolCall: { toolCallId: "c", kind: "execute", title: "bun run build" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      facts: { insideWorkdir: true, paths: [] },
    });
    expect(permissions[0]).toMatchObject({
      tenantId: owner.id,
      ownerUserId: owner.id,
    });
    await device({
      type: "acp.update",
      threadId: turn.threadId,
      turnId: turn.turnId,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "构建缺一个环境变量，已补上。" },
      },
    });
    await device({
      type: "acp.turn.end",
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason: "end_turn",
      interrupted: false,
    });
    // The answer is in the group, for the member who asked and for the hirer.
    for (const reader of [teammate, owner])
      await until(
        async () =>
          (await list(channel.id, reader)).messages.some(
            (message) =>
              message.agentId === external &&
              message.text === "构建缺一个环境变量，已补上。",
          ),
        "the answer in the group",
      );
    expect(turns.rows[0]?.status).toBe("done");
    await until(
      async () => (await cards())[0]?.status === "awaiting_review",
      "the card to close",
    );
    expect(await cards()).toEqual([
      { tenantId: owner.id, runRef, status: "awaiting_review" },
    ]);
    expect(await tasksUsed(owner.id)).toBe(hirerBefore + 1);
    expect(await tasksUsed(teammate.id)).toBe(teammateBefore);
  });
  test("asked by another member, its answer waits for its hirer's permission, never the asker's", async () => {
    const owner = await person();
    const teammate = await person();
    let decision: "pending" | "approved" = "pending";
    const opened: { actorId: string; frame: string }[] = [];
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async (action) => {
          opened.push({ actorId: action.actorId, frame: currentTenant() });
          return {
            id: `${prefix}-share-${opened.length}`,
            status: decision,
          } as never;
        },
        list: async () => [],
        rules: async () => [],
      },
    });
    const {
      external,
      writer,
      turns,
      down,
      conversations,
      device,
      sweepAll,
      list,
    } = await harness(owner, { privateShare });
    const channel = await runAsTenant(owner.id, () =>
      conversations.create(owner.id, { agentIds: [external, writer] }),
    );
    createdChannels.push(channel.id);
    const [{ email } = { email: "" }] = await runAsTenant(teammate.id, () =>
      database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, teammate.id)),
    );
    await runAsTenant(owner.id, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );

    await runAsTenant(teammate.id, () =>
      conversations.send(teammate.id, channel.id, {
        id: `${prefix}-p1`,
        text: "@小码 看看我的分支",
      }),
    );
    await sweepAll();
    // Its "started" notice is the server's own words: nobody is asked about it.
    expect(opened).toEqual([]);
    const turn = turns.rows[0] as AcpTurnRow;
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
      type: "acp.update",
      threadId: turn.threadId,
      turnId: turn.turnId,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "分支里有个配置写错了。" },
      },
    });
    await device({
      type: "acp.turn.end",
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason: "end_turn",
      interrupted: false,
    });

    // The ask goes to its hirer, in the hirer's frame; the member who asked is never asked.
    await until(() => opened.length > 0, "the share ask");
    expect(opened).toEqual([{ actorId: owner.id, frame: owner.id }]);
    const waiting = async () =>
      (await list(channel.id, teammate)).messages.find(
        (message) =>
          message.agentId === external && message.status === "waiting",
      );
    await until(async () => Boolean(await waiting()), "the held answer");
    expect(JSON.stringify(await list(channel.id, teammate))).not.toContain(
      "配置写错了",
    );

    // The hirer allows it, in their own frame: the held line is theirs, and the group reads it.
    decision = "approved";
    await runAsTenant(owner.id, () =>
      conversations.continueWaiting(`${prefix}-share-1`, async () => {
        throw new Error("a held answer is shown, not re-run");
      }),
    );
    for (const reader of [teammate, owner])
      expect(
        (await list(channel.id, reader)).messages.some(
          (message) =>
            message.agentId === external &&
            message.status === "completed" &&
            message.text === "分支里有个配置写错了。",
        ),
      ).toBe(true);
    expect(opened.every((ask) => ask.actorId === owner.id)).toBe(true);
  });
});
