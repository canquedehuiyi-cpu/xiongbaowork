import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationSidebar } from "@openbot/shared/conversation-sidebar";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  attachments,
  channelAgents,
  channelMemberships,
  channels,
  credentials,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  modelRegistry,
  modelTokenCalls,
  projectContextBindings,
  registeredDevices,
  resourceProjects,
  tasks,
  threadCompactions,
  threadContextBreakdowns,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import {
  meteringTenantFor,
  meteringTenantsFor,
} from "../src/models/runtime-resolver";
import {
  buildModelTokenCallRow,
  type MeteredBinding,
  sha256Hex,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";
import {
  createConversationSidebar,
  type SidebarDeps,
} from "../src/threads/sidebar";
import { createSidebarRoutes } from "../src/threads/sidebar-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 对话侧栏接口真库走一遍：单聊的四块、外部员工、群组（每位员工各取查看者自己那条线程）、同一线程两位员工
 * 分开、看不到的人 404、输出内容去重截 3 条，以及团队 Bot 用主人模型库时用量按计量所在的租户读。
 * 每个用例用自己的人和员工；路由前面的守卫和真的 `requireUser` 一样，在查看者自己的租户帧里跑。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `sidebar-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const table of [
      approvalRequests,
      modelTokenCalls,
      threadContextBreakdowns,
      threadCompactions,
      tasks,
      projectContextBindings,
    ] as const)
      await database.delete(table).where(inArray(table.tenantId, people));
    await database
      .delete(resourceProjects)
      .where(inArray(resourceProjects.tenantId, people));
    await database
      .delete(groupMessages)
      .where(inArray(groupMessages.channelId, channelIds));
    await database
      .delete(groupBotThreads)
      .where(inArray(groupBotThreads.channelId, channelIds));
    await database
      .delete(intelligenceChannelMappings)
      .where(inArray(intelligenceChannelMappings.channelId, channelIds));
    await database
      .delete(attachments)
      .where(inArray(attachments.channelId, channelIds));
    await database.delete(channels).where(inArray(channels.id, channelIds));
    await database.delete(threads).where(inArray(threads.tenantId, people));
    await database
      .delete(registeredDevices)
      .where(inArray(registeredDevices.tenantId, people));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, people));
    await database
      .delete(credentials)
      .where(inArray(credentials.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "侧栏测试" }),
  );
  return id;
}

/** 某人自己的员工。`modelRef` 是他模型库里的一行；外部员工给 `type: "device_acp"` 和它的配置。 */
async function employee(
  owner: string,
  name: string,
  options: {
    type?: "built_in" | "device_acp";
    configuration?: Record<string, unknown>;
    modelRef?: string | null;
  } = {},
): Promise<string> {
  const id = `${suite}-agent-${randomUUID()}`;
  agentIds.push(id);
  await runAsTenant(owner, async () => {
    await database.insert(agents).values({
      id,
      name,
      type: options.type ?? "built_in",
      configuration: options.configuration ?? { systemPrompt: "测试。" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner,
      title: name,
      roleDescription: "测试员工。",
      avatarSeed: id,
      visibility: "private",
      modelRef: options.modelRef ?? null,
    });
  });
  return id;
}

async function libraryModel(
  owner: string,
  label: string,
  contextWindow: number | null,
): Promise<string> {
  return runAsTenant(owner, async () => {
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "model",
        provider: "openai",
        encryptedValue: "sealed",
        keyId: `k-${randomUUID()}`,
        metadata: {},
      })
      .returning({ id: credentials.id });
    const [row] = await database
      .insert(modelRegistry)
      .values({
        provider: "openai",
        modelName: `m-${randomUUID()}`,
        label,
        contextWindow,
        credentialId: credential?.id,
      })
      .returning({ id: modelRegistry.id });
    return row?.id as string;
  });
}

/** 一个单聊：频道、成员、员工、查看者的线程（本地模式的 `threads` 行一起建）。 */
async function directChat(
  owner: string,
  agentId: string,
): Promise<{ channelId: string; threadId: string }> {
  const channelId = `${suite}-ch-${randomUUID()}`;
  const threadId = randomUUID();
  channelIds.push(channelId);
  await runAsTenant(owner, async () => {
    await database
      .insert(channels)
      .values({ id: channelId, name: "单聊", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: owner });
    await database.insert(channelAgents).values({ channelId, agentId });
    await database
      .insert(intelligenceChannelMappings)
      .values({ userId: owner, channelId, threadId });
    await database.insert(threads).values({ id: threadId, agentId });
  });
  return { channelId, threadId };
}

let clock = Date.parse("2026-11-15T08:00:00Z");
const tick = () => {
  clock += 60_000;
  return new Date(clock);
};

/** 一次报了用量的已结束调用，写在 `tenantId` 名下，像计量那样建行。 */
async function call(input: {
  tenantId: string;
  threadId: string;
  agentId: string;
  inputTokens: number;
  modelRef?: string;
}): Promise<void> {
  const binding: MeteredBinding = {
    tenantId: input.tenantId,
    agentId: input.agentId,
    modelRef: input.modelRef ?? randomUUID(),
    provider: "openai",
    modelName: "gpt-test",
    credentialId: randomUUID(),
    credentialDigest: sha256Hex("credential"),
    originalModelFingerprint: sha256Hex("fingerprint"),
    originalText: "openai/gpt-test",
  };
  const startedAt = tick();
  const row = buildModelTokenCallRow({
    binding,
    scope: { runId: `run-${randomUUID()}`, threadId: input.threadId },
    callId: randomUUID(),
    sdkProvider: binding.provider,
    sdkModelId: binding.modelName,
    startedAt,
    observedAt: new Date(startedAt.getTime() + 1_000),
    outcome: "completed",
    usage: { inputTokens: input.inputTokens, outputTokens: 10 },
  });
  await runAsTenant(input.tenantId, () =>
    database.insert(modelTokenCalls).values(row),
  );
}

async function card(
  tenantId: string,
  input: {
    title: string;
    channelRef: string;
    status?: "running" | "needs_action" | "awaiting_review" | "done" | "failed";
    pendingApprovalId?: string;
    deliverableRef?: unknown;
    executorAgentId?: string;
  },
): Promise<void> {
  await runAsTenant(tenantId, () =>
    database.insert(tasks).values({
      title: input.title,
      source: "chat",
      status: input.status ?? "running",
      channelRef: input.channelRef,
      pendingApprovalId: input.pendingApprovalId ?? null,
      deliverableRef: input.deliverableRef ?? null,
      executorAgentId: input.executorAgentId ?? null,
      updatedAt: tick(),
    }),
  );
}

async function upload(
  owner: string,
  channelId: string,
  name: string,
): Promise<string> {
  const [row] = await runAsTenant(owner, () =>
    database
      .insert(attachments)
      .values({
        channelId,
        uploadedBy: owner,
        name,
        mimeType: "text/plain",
        sizeBytes: 2,
        bytes: Buffer.from("hi"),
      })
      .returning({ id: attachments.id }),
  );
  return row?.id as string;
}

/** 一个还挂着的审批，在 `owner` 名下。 */
async function pendingApprovalRow(
  owner: string,
  status: "pending" | "approved" = "pending",
): Promise<string> {
  const id = `${suite}-approval-${randomUUID()}`;
  await runAsTenant(owner, () =>
    database.insert(approvalRequests).values({
      id,
      ownerUserId: owner,
      runId: `run-${randomUUID()}`,
      toolCallId: `call-${randomUUID()}`,
      actionDigest: sha256Hex(id),
      action: { tool: "computer_click", input: {} } as never,
      status,
      createdAt: tick(),
    }),
  );
  return id;
}

const noCatalogue = async () => undefined;

function routesFor(viewer: string, deps: Partial<SidebarDeps> = {}) {
  const sidebar = createConversationSidebar({
    database,
    runtime: "cloud",
    deploymentModelLabel: "openai/gpt-default",
    contextWindowFor: noCatalogue,
    meteringTenants: (agentIds) => meteringTenantsFor(database, agentIds),
    ...deps,
  });
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: viewer,
      email: `${viewer}@example.test`,
      role: "user",
    });
    // 和真的 `requireUser` 一样：请求在查看者自己的租户帧里跑。
    await runAsTenant(viewer, () => next());
  };
  const routes = createSidebarRoutes(sidebar, guard);
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/threads", routes.threads);
  app.route("/api/channels", routes.channels);
  return {
    async thread(threadId: string, agentId?: string) {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
      const response = await app.request(
        `/api/threads/${threadId}/sidebar${query}`,
      );
      return {
        status: response.status,
        body: (await response.json()) as ConversationSidebar,
      };
    },
    async channel(channelId: string, agentId?: string) {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
      const response = await app.request(
        `/api/channels/${channelId}/sidebar${query}`,
      );
      return {
        status: response.status,
        body: (await response.json()) as ConversationSidebar,
      };
    },
  };
}

describe("conversation sidebar", () => {
  test("a direct conversation returns environment, goal, context and outputs", async () => {
    const viewer = await person();
    const model = await libraryModel(viewer, "我的 GPT", 128_000);
    const agentId = await employee(viewer, "报销助理", { modelRef: model });
    const { channelId, threadId } = await directChat(viewer, agentId);

    // 设备模式：员工的动作落在查看者自己的电脑上，这台电脑上它在一个项目里。
    const [device] = await runAsTenant(viewer, () =>
      database
        .insert(registeredDevices)
        .values({
          deviceId: "desk-1",
          name: "办公室 Mac",
          tokenHash: sha256Hex(randomUUID()),
          lastSeenAt: new Date(),
        })
        .returning({ id: registeredDevices.id }),
    );
    const projectId = randomUUID();
    await runAsTenant(viewer, async () => {
      await database.insert(resourceProjects).values({
        id: projectId,
        deviceId: device?.id as string,
        scope: "public",
        name: "报销整理",
        source: {
          kind: "local",
          rootRef: "fld_AAAAAAAAAAAAAAAAAAAAAA",
          label: "报销",
          writable: false,
        },
      });
      await database.insert(projectContextBindings).values({
        deviceId: device?.id as string,
        agentId,
        projectId,
      });
      // 跑过三轮；最近一次快照里员工的回复。
      for (let index = 0; index < 3; index += 1)
        await database
          .insert(threadRuns)
          .values({ id: `run-${randomUUID()}`, threadId, agentId });
      await database
        .update(threads)
        .set({
          messagesSnapshot: [
            { id: "m1", role: "user", content: "帮我看看这几张发票" },
            {
              id: "m2",
              role: "assistant",
              content: "我已经整理好了三张发票。还有两张缺日期，需要你补。",
            },
          ],
        })
        .where(inArray(threads.id, [threadId]));
      await database.insert(threadContextBreakdowns).values({
        threadId,
        agentId,
        runId: "run-x",
        shares: {
          messages: 0.5,
          system: 0.3,
          tools: 0.2,
          skills: 0,
          memory: 0,
        },
      });
      await database.insert(threadCompactions).values({
        threadId,
        agentId,
        uptoMessageId: "m1",
        summary: "早前的对话。",
        auto: true,
      });
    });
    await call({
      tenantId: viewer,
      threadId,
      agentId,
      inputTokens: 32_000,
      modelRef: model,
    });
    const file = await upload(viewer, channelId, "发票汇总.xlsx");
    const approvalId = await pendingApprovalRow(viewer);
    await card(viewer, {
      title: "整理报销",
      channelRef: threadId,
      status: "needs_action",
      pendingApprovalId: approvalId,
      executorAgentId: agentId,
      deliverableRef: {
        kind: "deliverable",
        components: [{ name: "showTable", args: { title: "发票明细" } }],
        attachments: [file],
      },
    });

    const { status, body } = await routesFor(viewer, {
      runtime: "device",
      machinesOf: async (ids) =>
        new Map(
          ids.map((id) => [id, { tenantId: viewer, deviceId: "desk-1" }]),
        ),
    }).thread(threadId);
    expect(status).toBe(200);
    expect(body.environment).toEqual({
      kind: "device",
      deviceName: "办公室 Mac",
      online: true,
      project: { id: projectId, name: "报销整理" },
      model: { label: "我的 GPT" },
    });
    expect(body.goal).toEqual({
      title: "整理报销",
      status: "needs_action",
      rounds: 3,
      lastCheck: "等你确认 · 我已经整理好了三张发票。",
      pendingApprovalId: approvalId,
    });
    expect(body.context.usage?.used).toBe(32_000);
    expect(body.context.usage?.limit).toBe(128_000);
    expect(body.context.usage?.percent).toBe(25);
    expect(
      body.context.usage?.categories.find((entry) => entry.key === "messages")
        ?.tokens,
    ).toBe(16_000);
    expect(body.context.lastCompaction).toMatchObject({ auto: true });
    expect(body.context.managedBy).toBeUndefined();
    expect(body.outputs.total).toBe(2);
    expect(body.outputs.items.map((item) => [item.kind, item.title])).toEqual([
      ["file", "发票汇总.xlsx"],
      ["table", "发票明细"],
    ]);
    expect(body.outputs.items[0]?.href).toBe(`/api/attachments/${file}`);
    expect(body.outputs.items[0]?.byAgentId).toBe(agentId);

    // 同一对话按频道问，答案一样。
    const byChannel = await routesFor(viewer, {
      runtime: "device",
      machinesOf: async (ids) =>
        new Map(
          ids.map((id) => [id, { tenantId: viewer, deviceId: "desk-1" }]),
        ),
    }).channel(channelId);
    expect(byChannel.status).toBe(200);
    expect(byChannel.body).toEqual(body);
  });

  test("no usage yet → context.usage.used null", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "新员工");
    const { threadId } = await directChat(viewer, agentId);

    const { status, body } = await routesFor(viewer).thread(threadId);
    expect(status).toBe(200);
    expect(body.context.usage?.used).toBeNull();
    expect(body.context.usage?.percent).toBeNull();
    expect(body.context.lastCompaction).toBeNull();
    expect(body.goal).toBeNull();
    expect(body.outputs).toEqual({ items: [], total: 0 });
    // 云端、没绑模型：部署默认模型。
    expect(body.environment).toEqual({
      kind: "cloud",
      project: null,
      model: { label: "openai/gpt-default" },
    });
  });

  test("external employee → context.managedBy is the harness label and no usage", async () => {
    const viewer = await person();
    await runAsTenant(viewer, () =>
      database.insert(registeredDevices).values({
        deviceId: "laptop-1",
        name: "我的笔记本",
        tokenHash: sha256Hex(randomUUID()),
        lastSeenAt: new Date(Date.now() - 10 * 60_000),
        roots: [{ ref: "fld_BBBBBBBBBBBBBBBBBBBBBB", name: "报销项目" }],
      }),
    );
    const agentId = await employee(viewer, "Codex 员工", {
      type: "device_acp",
      configuration: {
        deviceId: "laptop-1",
        harness: "codex",
        workdirRef: "fld_BBBBBBBBBBBBBBBBBBBBBB",
      },
    });
    const { threadId } = await directChat(viewer, agentId);
    // 就算有一行计量（不该有），外部员工也不显示用量。
    await call({ tenantId: viewer, threadId, agentId, inputTokens: 999 });

    const { status, body } = await routesFor(viewer).thread(threadId);
    expect(status).toBe(200);
    expect(body.context.managedBy).toBe("Codex");
    expect(body.context.usage).toBeUndefined();
    expect(body.environment).toEqual({
      kind: "device",
      deviceName: "我的笔记本",
      online: false,
      workdirName: "报销项目",
      model: {
        label: "外部员工 · Codex · 用你自己的订阅",
        external: { harness: "Codex" },
      },
    });
  });

  test("group: an external employee's member row names its harness", async () => {
    const viewer = await person();
    const writer = await employee(viewer, "写手");
    const coder = await employee(viewer, "代码熊", {
      type: "device_acp",
      configuration: { deviceId: "laptop-1", harness: "codex" },
    });
    const channelId = `${suite}-group-${randomUUID()}`;
    channelIds.push(channelId);
    await runAsTenant(viewer, async () => {
      await database.insert(channels).values({
        id: channelId,
        tenantId: TEAM_TENANT,
        name: "群组",
        description: "",
      });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: viewer, tenantId: TEAM_TENANT });
      for (const agentId of [writer, coder])
        await database
          .insert(channelAgents)
          .values({ channelId, agentId, tenantId: TEAM_TENANT });
      await database.insert(intelligenceChannelMappings).values({
        userId: viewer,
        channelId,
        threadId: randomUUID(),
      });
    });
    const { status, body } = await routesFor(viewer).channel(channelId);
    expect(status).toBe(200);
    const members = new Map(
      (body.environment.members ?? []).map((member) => [
        member.agentId,
        member,
      ]),
    );
    expect(members.get(coder)?.harness).toBe("Codex");
    expect(members.get(writer)?.harness).toBeUndefined();
  });

  test("group: members list, per-agent usage is the viewer's own thread per employee", async () => {
    const viewer = await person();
    const other = await person();
    const writerModel = await libraryModel(viewer, "写作模型", 100_000);
    const checkerModel = await libraryModel(viewer, "审核模型", 200_000);
    const writer = await employee(viewer, "写手", { modelRef: writerModel });
    const checker = await employee(viewer, "审核", { modelRef: checkerModel });
    const channelId = `${suite}-group-${randomUUID()}`;
    channelIds.push(channelId);
    const mine = { writer: randomUUID(), checker: randomUUID() };
    const theirs = randomUUID();
    await runAsTenant(viewer, async () => {
      await database.insert(channels).values({
        id: channelId,
        tenantId: TEAM_TENANT,
        name: "群组",
        description: "",
      });
      for (const userId of [viewer, other])
        await database
          .insert(channelMemberships)
          .values({ channelId, userId, tenantId: TEAM_TENANT });
      for (const agentId of [writer, checker])
        await database
          .insert(channelAgents)
          .values({ channelId, agentId, tenantId: TEAM_TENANT });
      await database.insert(intelligenceChannelMappings).values({
        userId: viewer,
        channelId,
        threadId: randomUUID(),
      });
      await database.insert(groupBotThreads).values([
        {
          ownerUserId: viewer,
          channelId,
          agentId: writer,
          threadId: mine.writer,
          tenantId: TEAM_TENANT,
        },
        {
          ownerUserId: viewer,
          channelId,
          agentId: checker,
          threadId: mine.checker,
          tenantId: TEAM_TENANT,
        },
      ]);
      await database.insert(threads).values({
        id: mine.writer,
        agentId: writer,
      });
      await database.insert(threadRuns).values({
        id: `run-${randomUUID()}`,
        threadId: mine.writer,
        agentId: writer,
      });
      await database.insert(groupMessages).values({
        id: `${suite}-gm-${randomUUID()}`,
        channelId,
        ownerUserId: viewer,
        agentId: writer,
        threadId: mine.writer,
        text: "初稿写好了！请看第二段。",
        tenantId: TEAM_TENANT,
      });
    });
    await runAsTenant(other, () =>
      database.insert(groupBotThreads).values({
        ownerUserId: other,
        channelId,
        agentId: writer,
        threadId: theirs,
        tenantId: TEAM_TENANT,
      }),
    );
    await call({
      tenantId: viewer,
      threadId: mine.writer,
      agentId: writer,
      inputTokens: 25_000,
      modelRef: writerModel,
    });
    await call({
      tenantId: viewer,
      threadId: mine.checker,
      agentId: checker,
      inputTokens: 50_000,
      modelRef: checkerModel,
    });
    // 另一位成员和写手那条线程用得很多：不算到查看者头上。
    await call({
      tenantId: other,
      threadId: theirs,
      agentId: writer,
      inputTokens: 90_000,
    });
    await runAsTenant(viewer, () =>
      database.insert(threadCompactions).values({
        threadId: mine.checker,
        agentId: checker,
        uptoMessageId: "x",
        summary: "摘要。",
        auto: false,
      }),
    );
    await card(viewer, {
      title: "写一篇周报",
      channelRef: channelId,
      status: "running",
    });

    const routes = routesFor(viewer);
    const { status, body } = await routes.channel(channelId);
    expect(status).toBe(200);
    expect(body.environment.kind).toBe("cloud");
    expect(body.environment.model).toBeNull();
    expect(
      body.environment.members?.map((member) => [
        member.agentId,
        member.name,
        member.status,
        member.where,
      ]),
    ).toEqual(
      [
        [writer, "写手", "resting", "云端"],
        [checker, "审核", "resting", "云端"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const perAgent = new Map(
      (body.context.perAgent ?? []).map((entry) => [entry.agentId, entry]),
    );
    expect(perAgent.get(writer)?.percent).toBe(25);
    expect(perAgent.get(writer)?.used).toBe(25_000);
    expect(perAgent.get(writer)?.limit).toBe(100_000);
    expect(perAgent.get(writer)?.compactedAt).toBeNull();
    expect(perAgent.get(writer)?.compactedAuto).toBeNull();
    expect(perAgent.get(checker)?.percent).toBe(25);
    expect(perAgent.get(checker)?.used).toBe(50_000);
    expect(perAgent.get(checker)?.limit).toBe(200_000);
    expect(perAgent.get(checker)?.compactedAt).toEqual(expect.any(String));
    expect(perAgent.get(checker)?.compactedAuto).toEqual(expect.any(Boolean));
    expect(body.context.usage).toBeUndefined();
    expect(body.goal).toEqual({
      title: "写一篇周报",
      status: "running",
      rounds: 1,
      lastCheck: "进行中 · 初稿写好了！",
      pendingApprovalId: null,
    });

    // 点名字看明细：查看者自己和写手那条线程。
    const detail = await routes.channel(channelId, writer);
    expect(detail.status).toBe(200);
    expect(detail.body.context.usage?.used).toBe(25_000);
    expect(detail.body.context.usage?.limit).toBe(100_000);
    expect(detail.body.context.lastCompaction).toBeNull();

    // 不在这个群里的员工：当作看不到。
    const outsider = await employee(viewer, "群外员工");
    expect((await routes.channel(channelId, outsider)).status).toBe(404);

    // 按查看者自己的群组线程问，就是那位员工的明细。
    const byThread = await routes.thread(mine.checker);
    expect(byThread.status).toBe(200);
    expect(byThread.body.context.usage?.used).toBe(50_000);
    expect(byThread.body.context.lastCompaction).toMatchObject({
      auto: false,
    });
  });

  test("two employees in one thread keep separate usage", async () => {
    const viewer = await person();
    const first = await employee(viewer, "前台");
    const second = await employee(viewer, "财务");
    const { threadId } = await directChat(viewer, first);
    // 前台把对话转给财务，财务在同一条线程里跑了一轮。
    await runAsTenant(viewer, () =>
      database
        .insert(threadRuns)
        .values({ id: `run-${randomUUID()}`, threadId, agentId: second }),
    );
    await call({
      tenantId: viewer,
      threadId,
      agentId: first,
      inputTokens: 1_000,
    });
    await call({
      tenantId: viewer,
      threadId,
      agentId: second,
      inputTokens: 7_000,
    });

    const routes = routesFor(viewer);
    const mine = await routes.thread(threadId);
    expect(mine.status).toBe(200);
    expect(mine.body.context.usage?.used).toBe(1_000);
    expect(
      (mine.body.context.perAgent ?? []).map((entry) => entry.agentId).sort(),
    ).toEqual([first, second].sort());
    const theirs = await routes.thread(threadId, second);
    expect(theirs.status).toBe(200);
    expect(theirs.body.context.usage?.used).toBe(7_000);
    // 不在这个对话里的员工：当作看不到。
    const stranger = await employee(viewer, "路人");
    expect((await routes.thread(threadId, stranger)).status).toBe(404);
  });

  test("someone who cannot see the conversation gets 404", async () => {
    const owner = await person();
    const outsider = await person();
    const agentId = await employee(owner, "私人助理");
    const { channelId, threadId } = await directChat(owner, agentId);
    await call({ tenantId: owner, threadId, agentId, inputTokens: 5_000 });

    const routes = routesFor(outsider);
    const byThread = await routes.thread(threadId);
    const byChannel = await routes.channel(channelId);
    const missing = await routes.thread(randomUUID());
    expect(byThread.status).toBe(404);
    expect(byChannel.status).toBe(404);
    expect(missing.status).toBe(404);
    // 不说为什么：别人的对话和不存在的对话答得一样。
    expect(byThread.body).toEqual(missing.body);
    expect(byChannel.body).toEqual(missing.body);

    // 群组成员也看不到另一位成员和员工的那条线程。
    const member = await person();
    const groupId = `${suite}-group-${randomUUID()}`;
    channelIds.push(groupId);
    const ownersThread = randomUUID();
    await runAsTenant(owner, async () => {
      await database.insert(channels).values({
        id: groupId,
        tenantId: TEAM_TENANT,
        name: "群组",
        description: "",
      });
      for (const userId of [owner, member])
        await database
          .insert(channelMemberships)
          .values({ channelId: groupId, userId, tenantId: TEAM_TENANT });
      await database.insert(groupBotThreads).values({
        ownerUserId: owner,
        channelId: groupId,
        agentId,
        threadId: ownersThread,
        tenantId: TEAM_TENANT,
      });
    });
    expect((await routesFor(member).thread(ownersThread)).status).toBe(404);
  });

  test("outputs are newest first, deduped, capped at 3 with total", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "分析师");
    const { channelId, threadId } = await directChat(viewer, agentId);
    const a = await upload(viewer, channelId, "a.csv");
    const b = await upload(viewer, channelId, "b.csv");
    const c = await upload(viewer, channelId, "c.csv");
    const deliverable = (files: string[], components: unknown[] = []) => ({
      kind: "deliverable",
      components,
      attachments: files,
    });
    // 旧 → 新；第二张卡又带了 a，第三张卡写的是频道 id。
    await card(viewer, {
      title: "第一轮",
      channelRef: threadId,
      // 和第二张卡上的报告同名，但是另一份交付物：各算一条。
      deliverableRef: deliverable(
        [a],
        [{ name: "showActivityReport", args: { title: "周报", week: 1 } }],
      ),
    });
    await card(viewer, {
      title: "第二轮",
      channelRef: threadId,
      deliverableRef: deliverable(
        [a, b],
        [{ name: "showActivityReport", args: { title: "周报" } }],
      ),
    });
    await card(viewer, {
      title: "第三轮",
      channelRef: channelId,
      deliverableRef: deliverable([c]),
    });
    // 不是输出的记录（如熔断）不算。
    await card(viewer, {
      title: "第四轮",
      channelRef: threadId,
      deliverableRef: { kind: "circuit_breaker", failures: 3 },
    });

    const { status, body } = await routesFor(viewer).thread(threadId);
    expect(status).toBe(200);
    expect(body.outputs.total).toBe(5);
    expect(body.outputs.items.map((item) => item.title)).toEqual([
      "c.csv",
      "a.csv",
      "b.csv",
    ]);
    expect(body.goal?.title).toBe("第四轮");
  });

  test("usage on the owner's model library is read in the tenant it is metered in", async () => {
    const viewer = await person();
    const owner = await person();
    const agentId = await employee(viewer, "团队员工");
    const { threadId } = await directChat(viewer, agentId);
    // 计量写在主人名下；分类比例写在发起运行的人（查看者）名下。
    await call({ tenantId: owner, threadId, agentId, inputTokens: 40_000 });
    await runAsTenant(viewer, () =>
      database.insert(threadContextBreakdowns).values({
        threadId,
        agentId,
        runId: "run-team",
        shares: { messages: 1, system: 0, tools: 0, skills: 0, memory: 0 },
      }),
    );

    const { status, body } = await routesFor(viewer, {
      meteringTenants: async (asked) =>
        new Map(asked.map((id) => [id, id === agentId ? owner : null])),
    }).thread(threadId);
    expect(status).toBe(200);
    expect(body.context.usage?.used).toBe(40_000);
    expect(
      body.context.usage?.categories.find((entry) => entry.key === "messages")
        ?.tokens,
    ).toBe(40_000);

    // 看不到这个对话的人，问不出主人名下的用量。
    const outsider = await routesFor(owner, {
      meteringTenants: async (asked) => new Map(asked.map((id) => [id, owner])),
    }).thread(threadId);
    expect(outsider.status).toBe(404);
  });

  test("a pending approval on an older card still shows when the newest card is running", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "审批员工");
    const { channelId, threadId } = await directChat(viewer, agentId);
    const decided = await pendingApprovalRow(viewer, "approved");
    const waiting = await pendingApprovalRow(viewer);
    await card(viewer, {
      title: "已批过的",
      channelRef: threadId,
      status: "done",
      pendingApprovalId: decided,
    });
    await card(viewer, {
      title: "等确认的旧卡",
      channelRef: channelId,
      status: "needs_action",
      pendingApprovalId: waiting,
    });
    await card(viewer, { title: "新的一轮", channelRef: threadId });

    const { status, body } = await routesFor(viewer).thread(threadId);
    expect(status).toBe(200);
    expect(body.goal?.title).toBe("新的一轮");
    expect(body.goal?.status).toBe("running");
    expect(body.goal?.pendingApprovalId).toBe(waiting);
  });

  test("a group's query count does not grow with its employees", async () => {
    /** 一个群组：每位员工有查看者的线程、一次计量、一行比例、一次压缩。 */
    async function groupOf(
      viewer: string,
      size: number,
    ): Promise<{ channelId: string; ids: string[] }> {
      const model = await libraryModel(viewer, `模型-${size}`, 100_000);
      const ids: string[] = [];
      for (let index = 0; index < size; index += 1)
        ids.push(await employee(viewer, `员工${index}`, { modelRef: model }));
      const channelId = `${suite}-group-${randomUUID()}`;
      channelIds.push(channelId);
      const threadOf = new Map(ids.map((id) => [id, randomUUID()]));
      await runAsTenant(viewer, async () => {
        await database
          .insert(channels)
          .values({ id: channelId, name: "群组", description: "" });
        await database
          .insert(channelMemberships)
          .values({ channelId, userId: viewer });
        await database
          .insert(channelAgents)
          .values(ids.map((agentId) => ({ channelId, agentId })));
        await database.insert(groupBotThreads).values(
          ids.map((agentId) => ({
            ownerUserId: viewer,
            channelId,
            agentId,
            threadId: threadOf.get(agentId) as string,
          })),
        );
        await database.insert(threadContextBreakdowns).values(
          ids.map((agentId) => ({
            threadId: threadOf.get(agentId) as string,
            agentId,
            runId: "run",
            shares: { messages: 1, system: 0, tools: 0, skills: 0, memory: 0 },
          })),
        );
        await database.insert(threadCompactions).values(
          ids.map((agentId) => ({
            threadId: threadOf.get(agentId) as string,
            agentId,
            uptoMessageId: "m",
            summary: "摘要。",
            auto: true,
          })),
        );
      });
      for (const agentId of ids)
        await call({
          tenantId: viewer,
          threadId: threadOf.get(agentId) as string,
          agentId,
          inputTokens: 10_000,
          modelRef: model,
        });
      await card(viewer, { title: "群组的活", channelRef: channelId });
      return { channelId, ids };
    }

    /** 数一次请求里发到数据库的语句（每条语句借一次连接）。 */
    async function statements(work: () => Promise<unknown>): Promise<number> {
      const client = database.$client as unknown as {
        reserve: (...args: unknown[]) => Promise<unknown>;
      };
      const original = client.reserve;
      let calls = 0;
      client.reserve = (...args: unknown[]) => {
        calls += 1;
        return original.apply(client, args);
      };
      try {
        await work();
      } finally {
        client.reserve = original;
      }
      return calls;
    }

    const viewer = await person();
    const small = await groupOf(viewer, 2);
    const large = await groupOf(viewer, 20);
    const routes = routesFor(viewer, {
      runtime: "device",
      machinesOf: async (ids) =>
        new Map(ids.map((id) => [id, { tenantId: viewer, deviceId: "none" }])),
    });
    const smallCount = await statements(async () => {
      const { status, body } = await routes.channel(small.channelId);
      expect(status).toBe(200);
      expect(body.context.perAgent).toHaveLength(2);
    });
    const largeCount = await statements(async () => {
      const { status, body } = await routes.channel(large.channelId);
      expect(status).toBe(200);
      expect(body.context.perAgent).toHaveLength(20);
      expect(
        body.context.perAgent?.every(
          (entry) => entry.used === 10_000 && entry.compactedAt,
        ),
      ).toBe(true);
    });
    expect(largeCount).toBe(smallCount);
    expect(largeCount).toBeLessThan(40);
    // 明细复用算好的那一份：带 ?agentId= 不多查用量。
    const detailCount = await statements(async () => {
      const { body } = await routes.channel(large.channelId, large.ids[7]);
      expect(body.context.usage?.used).toBe(10_000);
    });
    expect(detailCount).toBeLessThanOrEqual(largeCount + 1);
  });

  test("meteringTenantFor answers what the model resolver meters under", async () => {
    const viewer = await person();
    const unbound = await employee(viewer, "默认模型员工");
    const bound = await employee(viewer, "绑定模型员工", {
      modelRef: await libraryModel(viewer, "自己的模型", null),
    });
    // 没绑模型：部署默认模型，记在发起运行的人名下。
    expect(
      await runAsTenant(viewer, () => meteringTenantFor(database, unbound)),
    ).toBe(viewer);
    // 绑了自己模型库里的一行：记在那一行所在的租户。
    expect(
      await runAsTenant(viewer, () => meteringTenantFor(database, bound)),
    ).toBe(viewer);
    // 不是某个人的帧：默认模型没人可记，回 null；绑定的模型库行仍记在那一行的租户（帧与计量租户不同）。
    expect(
      await runAsTenant("platform", () => meteringTenantFor(database, unbound)),
    ).toBeNull();
    expect(
      await runAsTenant("platform", () => meteringTenantFor(database, bound)),
    ).toBe(viewer);
  });
});
