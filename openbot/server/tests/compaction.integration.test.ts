import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { MockLanguageModelV3 } from "ai/test";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  credentials,
  groupBotThreads,
  intelligenceChannelMappings,
  modelRegistry,
  modelTokenCalls,
  threadCompactions,
  threadContextBreakdowns,
  threads,
  users,
} from "../src/db/schema";
import {
  meteredDeploymentModel,
  meteringTenantsFor,
} from "../src/models/runtime-resolver";
import {
  buildModelTokenCallRow,
  databaseTokenCallSink,
  type MeteredBinding,
  sha256Hex,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";
import {
  advisoryThreadLock,
  applyCompaction,
  COMPACTION_DONE_EVENT,
  COMPACTION_FAILED_EVENT,
  COMPACTION_SUMMARY_MESSAGE_ID,
  type CompactionDeps,
  type CompactionResult,
  compactThread,
  latestCompaction,
  modelSummarizer,
  runCompaction,
  type Summarize,
} from "../src/threads/compaction";
import {
  COMPACTION_RUN_PREFIX,
  contextBreakdownRecorder,
  readContextUsage,
} from "../src/threads/context-usage";
import { createConversationSidebar } from "../src/threads/sidebar";
import { createSidebarRoutes } from "../src/threads/sidebar-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 压缩会话真库走一遍：手动压缩（单聊、群组按查看者 × 员工那条线程）、再压一次时并入上次摘要、并发只压一次、
 * 总结失败或为空不写记录且这一轮照常跑、一轮开始前按已用 ≥ 上限 − 预留自动压缩（摘要真的送到模型面前，
 * 早先的消息不再发）、没有上限不自动压缩、外部员工 409、看不到的 404，以及压缩那次模型调用计在本线程。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `compact-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const table of [
      modelTokenCalls,
      threadContextBreakdowns,
      threadCompactions,
    ] as const)
      await database.delete(table).where(inArray(table.tenantId, people));
    await database
      .delete(groupBotThreads)
      .where(inArray(groupBotThreads.channelId, channelIds));
    await database
      .delete(intelligenceChannelMappings)
      .where(inArray(intelligenceChannelMappings.channelId, channelIds));
    await database.delete(channels).where(inArray(channels.id, channelIds));
    await database.delete(threads).where(inArray(threads.tenantId, people));
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
      .values({ id, email: `${id}@example.test`, name: "压缩测试" }),
  );
  return id;
}

async function employee(
  owner: string,
  name: string,
  options: {
    type?: "built_in" | "device_acp" | "remote_ag_ui";
    modelRef?: string;
  } = {},
): Promise<string> {
  const id = `${suite}-agent-${randomUUID()}`;
  agentIds.push(id);
  await runAsTenant(owner, async () => {
    await database.insert(agents).values({
      id,
      name,
      type: options.type ?? "built_in",
      configuration:
        options.type === "device_acp"
          ? { deviceId: "desk", harness: "codex", workdirRef: "root" }
          : options.type === "remote_ag_ui"
            ? { url: "https://agent.example.test/run" }
            : { systemPrompt: "测试。" },
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
        label: "测试模型",
        contextWindow,
        credentialId: credential?.id,
      })
      .returning({ id: modelRegistry.id });
    return row?.id as string;
  });
}

const say = (index: number, tag = "m"): Message =>
  index % 2 === 0
    ? {
        id: `${tag}${index}`,
        role: "user",
        content: `用户第 ${index} 句（${tag}）`,
      }
    : {
        id: `${tag}${index}`,
        role: "assistant",
        content: `员工第 ${index} 句（${tag}）`,
      };

const history = (count: number, tag = "m") =>
  Array.from({ length: count }, (_, index) => say(index, tag));

/** 单聊：频道、成员、员工、查看者的线程（本地模式的 `threads` 行带着消息）。 */
async function directChat(
  owner: string,
  agentId: string,
  messages: Message[],
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
    await database
      .insert(threads)
      .values({ id: threadId, agentId, messagesSnapshot: messages });
  });
  return { channelId, threadId };
}

// 在过去：压缩记录按真实时间记，晚于这些调用。
let clock = Date.now() - 24 * 60 * 60 * 1000;
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
  modelRef: string;
}): Promise<void> {
  const binding: MeteredBinding = {
    tenantId: input.tenantId,
    agentId: input.agentId,
    modelRef: input.modelRef,
    provider: "openai",
    modelName: "gpt-test",
    credentialId: randomUUID(),
    credentialDigest: sha256Hex("credential"),
    originalModelFingerprint: sha256Hex("fingerprint"),
    originalText: "openai/gpt-test",
  };
  const startedAt = tick();
  await runAsTenant(input.tenantId, () =>
    database.insert(modelTokenCalls).values(
      buildModelTokenCallRow({
        binding,
        scope: { runId: `run-${randomUUID()}`, threadId: input.threadId },
        callId: randomUUID(),
        sdkProvider: binding.provider,
        sdkModelId: binding.modelName,
        startedAt,
        observedAt: new Date(startedAt.getTime() + 1_000),
        outcome: "completed",
        usage: { inputTokens: input.inputTokens, outputTokens: 10 },
      }),
    ),
  );
}

/** 读线程快照，像生产里从线程存储读一样，在那个人的帧里。 */
const snapshotOf = (tenantId: string, threadId: string) =>
  runAsTenant(tenantId, async () => {
    const [row] = await database
      .select({ messages: threads.messagesSnapshot })
      .from(threads)
      .where(eq(threads.id, threadId));
    return (row?.messages ?? []) as Message[];
  });

type Summaries = { prompts: string[]; systems: string[] };

/** 假的总结：记下发出去的内容，按顺序答 `answers`（函数可以抛错或拖一会儿）。 */
function fakeSummarize(
  ...answers: (string | (() => Promise<string>))[]
): Summarize & Summaries {
  const prompts: string[] = [];
  const systems: string[] = [];
  let index = 0;
  const summarize = async (input: { system: string; prompt: string }) => {
    prompts.push(input.prompt);
    systems.push(input.system);
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return typeof answer === "function" ? answer() : (answer ?? "");
  };
  return Object.assign(summarize, { prompts, systems });
}

function depsWith(summarize: Summarize): CompactionDeps {
  return {
    database,
    contextWindowFor: async () => undefined,
    meteringTenant: async (agentId) =>
      (await meteringTenantsFor(database, [agentId])).get(agentId) ?? null,
    loadMessages: ({ tenantId, threadId }) => snapshotOf(tenantId, threadId),
    summarize,
    lock: advisoryThreadLock(testDatabaseUrl()),
  };
}

const compactionRows = (tenantId: string, threadId: string) =>
  runAsTenant(tenantId, () =>
    database
      .select()
      .from(threadCompactions)
      .where(
        and(
          eq(threadCompactions.tenantId, tenantId),
          eq(threadCompactions.threadId, threadId),
        ),
      ),
  );

function routesFor(
  viewer: string,
  summarize: Summarize,
  overrides: Partial<CompactionDeps> = {},
) {
  const sidebar = createConversationSidebar({
    database,
    runtime: "cloud",
    deploymentModelLabel: "openai/gpt-default",
    contextWindowFor: async () => undefined,
    meteringTenants: (ids) => meteringTenantsFor(database, ids),
  });
  const deps = { ...depsWith(summarize), ...overrides };
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: viewer,
      email: `${viewer}@example.test`,
      role: "user",
    });
    await runAsTenant(viewer, () => next());
  };
  const routes = createSidebarRoutes(sidebar, guard, (who, target) =>
    compactThread(
      {
        tenantId: who.id,
        threadId: target.threadId,
        agentId: target.agentId,
        auto: false,
      },
      deps,
    ),
  );
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/threads", routes.threads);
  app.route("/api/channels", routes.channels);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const get = async (path: string) => {
    const response = await app.request(path);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {
    thread: (threadId: string, agentId?: string) =>
      post(`/api/threads/${threadId}/compact`, agentId ? { agentId } : {}),
    channel: (channelId: string, agentId?: string) =>
      post(`/api/channels/${channelId}/compact`, agentId ? { agentId } : {}),
    sidebar: (threadId: string) => get(`/api/threads/${threadId}/sidebar`),
    summaryInThread: (threadId: string, compactionId: string) =>
      get(`/api/threads/${threadId}/compactions/${compactionId}`),
    summaryInChannel: (channelId: string, compactionId: string) =>
      get(`/api/channels/${channelId}/compactions/${compactionId}`),
  };
}

describe("manual compaction", () => {
  test("keeps the last 10 messages and summarises the rest into one system message", async () => {
    const viewer = await person();
    const model = await libraryModel(viewer, 100_000);
    const agentId = await employee(viewer, "助理", { modelRef: model });
    const messages = history(25);
    const { threadId } = await directChat(viewer, agentId, messages);
    await call({
      tenantId: viewer,
      threadId,
      agentId,
      inputTokens: 40_000,
      modelRef: model,
    });
    await runAsTenant(viewer, () =>
      database.insert(threadContextBreakdowns).values({
        threadId,
        agentId,
        runId: "run",
        shares: { messages: 0.5, system: 0.5, tools: 0, skills: 0, memory: 0 },
      }),
    );
    const summarize = fakeSummarize("用户决定用方案 B；还差报销单没交。");

    const response = await routesFor(viewer, summarize).thread(threadId);
    expect(response.status).toBe(200);
    expect(response.body.tokensBefore).toBe(40_000);
    // 消息那一份（20 000）按字数缩小，其余不变。
    expect(response.body.tokensAfter as number).toBeGreaterThan(20_000);
    expect(response.body.tokensAfter as number).toBeLessThan(40_000);
    expect(typeof response.body.compactionId).toBe("string");

    // 较早的 15 条进了总结，最近 10 条没有。
    expect(summarize.prompts).toHaveLength(1);
    expect(summarize.prompts[0]).toContain("用户第 0 句");
    expect(summarize.prompts[0]).toContain("员工第 13 句");
    expect(summarize.prompts[0]).toContain("用户第 14 句");
    expect(summarize.prompts[0]).not.toContain("员工第 15 句");
    expect(summarize.systems[0]).toContain("寒暄");

    const [row] = await compactionRows(viewer, threadId);
    expect(row).toMatchObject({
      tenantId: viewer,
      agentId,
      uptoMessageId: "m14",
      summary: "用户决定用方案 B；还差报销单没交。",
      auto: false,
      tokensBefore: 40_000,
    });
    const record = await runAsTenant(viewer, () =>
      latestCompaction(database, { tenantId: viewer, threadId, agentId }),
    );
    const applied = applyCompaction(messages, record);
    expect(applied).toHaveLength(11);
    expect(applied[0]).toEqual({
      id: COMPACTION_SUMMARY_MESSAGE_ID,
      role: "system",
      content: "早前对话摘要：用户决定用方案 B；还差报销单没交。",
    });
    expect(applied.slice(1)).toEqual(messages.slice(15));
  });

  test("the original messages stay in the thread", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const messages = history(14);
    const { threadId } = await directChat(viewer, agentId, messages);
    const response = await routesFor(viewer, fakeSummarize("摘要。")).thread(
      threadId,
    );
    expect(response.status).toBe(200);
    // 没有用量时不编前后数。
    expect(response.body).toMatchObject({
      tokensBefore: null,
      tokensAfter: null,
    });
    expect(await snapshotOf(viewer, threadId)).toEqual(messages);
    const [row] = await compactionRows(viewer, threadId);
    expect(row?.uptoMessageId).toBe("m3");
  });

  test("ten messages or fewer → nothing to compact", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const { threadId } = await directChat(viewer, agentId, history(10));
    const summarize = fakeSummarize("摘要。");
    const response = await routesFor(viewer, summarize).thread(threadId);
    expect(response).toEqual({
      status: 409,
      body: expect.objectContaining({ reason: "too_short" }),
    });
    expect(summarize.prompts).toHaveLength(0);
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("a second compaction folds the previous summary in", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const first = history(20);
    const { threadId } = await directChat(viewer, agentId, first);
    const summarize = fakeSummarize("第一次摘要：定了方案 B。", "第二次摘要。");
    const routes = routesFor(viewer, summarize);
    expect((await routes.thread(threadId)).status).toBe(200);

    const more = [...first, ...history(12, "n")];
    await runAsTenant(viewer, () =>
      database
        .update(threads)
        .set({ messagesSnapshot: more })
        .where(eq(threads.id, threadId)),
    );
    expect((await routes.thread(threadId)).status).toBe(200);

    const prompt = summarize.prompts[1] as string;
    expect(prompt).toContain("第一次摘要：定了方案 B。");
    // 上一次已经总结过的不再发一遍。
    expect(prompt).not.toContain("用户第 0 句（m）");
    expect(prompt).toContain("用户第 10 句（m）");
    const record = await runAsTenant(viewer, () =>
      latestCompaction(database, { tenantId: viewer, threadId, agentId }),
    );
    expect(record).toMatchObject({
      uptoMessageId: "n1",
      summary: "第二次摘要。",
    });
    const applied = applyCompaction(more, record);
    expect(applied).toHaveLength(11);
    expect(applied[0]?.content).toBe("早前对话摘要：第二次摘要。");
  });

  test("concurrent compaction of the same thread runs once", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const { threadId } = await directChat(viewer, agentId, history(20));
    const summarize = fakeSummarize(async () => {
      await Bun.sleep(300);
      return "只总结一次。";
    });
    const deps = depsWith(summarize);
    const input = { tenantId: viewer, threadId, agentId, auto: false };
    const results = await Promise.all([
      compactThread(input, deps),
      compactThread(input, deps),
    ]);
    const statuses = results.map((result) =>
      result.status === "compacted" ? "compacted" : result.reason,
    );
    expect(statuses.sort()).toEqual(["compacted", "in_progress"]);
    expect(summarize.prompts).toHaveLength(1);
    expect(await compactionRows(viewer, threadId)).toHaveLength(1);

    // 跑完锁就放了：下一次照常能压。
    const again = await compactThread(input, {
      ...deps,
      loadMessages: async () => [...history(20), ...history(12, "n")],
    });
    expect(again.status).toBe("compacted");
  });

  test("summary failure or empty output writes nothing and the run proceeds", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const { threadId } = await directChat(viewer, agentId, history(20));
    const input = { tenantId: viewer, threadId, agentId, auto: false };
    const errors = console.error;
    console.error = () => {};
    let results: CompactionResult[];
    try {
      results = [
        await compactThread(
          input,
          depsWith(
            fakeSummarize(async () => {
              throw new Error("provider down");
            }),
          ),
        ),
        await compactThread(input, depsWith(fakeSummarize("   \n"))),
      ];
    } finally {
      console.error = errors;
    }
    expect(results).toEqual([
      { status: "skipped", reason: "failed" },
      { status: "skipped", reason: "failed" },
    ]);
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
    console.error = () => {};
    const response = await routesFor(viewer, fakeSummarize(""))
      .thread(threadId)
      .finally(() => {
        console.error = errors;
      });
    expect(response).toEqual({
      status: 502,
      body: expect.objectContaining({ reason: "failed" }),
    });
    // 运行那一侧（自动压缩失败）在下面的 auto 用例里：这一轮照常跑，只提示一次。
  });

  test("external employee → 409", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "Codex", { type: "device_acp" });
    const { threadId, channelId } = await directChat(
      viewer,
      agentId,
      history(20),
    );
    const summarize = fakeSummarize("不该被调用。");
    const routes = routesFor(viewer, summarize);
    for (const response of [
      await routes.thread(threadId),
      await routes.channel(channelId),
    ])
      expect(response).toEqual({
        status: 409,
        body: expect.objectContaining({ reason: "external" }),
      });
    // 直接调也一样不压。
    expect(
      await compactThread(
        { tenantId: viewer, threadId, agentId, auto: false },
        depsWith(summarize),
      ),
    ).toEqual({ status: "skipped", reason: "external" });
    expect(summarize.prompts).toHaveLength(0);
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("cannot see the conversation → 404", async () => {
    const owner = await person();
    const stranger = await person();
    const agentId = await employee(owner, "助理");
    const { threadId, channelId } = await directChat(
      owner,
      agentId,
      history(20),
    );
    const summarize = fakeSummarize("不该被调用。");
    const routes = routesFor(stranger, summarize);
    for (const response of [
      await routes.thread(threadId),
      await routes.channel(channelId),
      await routes.thread(randomUUID()),
    ])
      expect(response).toEqual({
        status: 404,
        body: { error: "Conversation not found." },
      });
    // 主人自己：不在对话里的员工也是 404。
    const outsider = await employee(owner, "别的员工");
    expect(
      (await routesFor(owner, summarize).thread(threadId, outsider)).status,
    ).toBe(404);
    expect(summarize.prompts).toHaveLength(0);
    expect(await compactionRows(owner, threadId)).toHaveLength(0);
  });

  test("group: only the viewer's own thread with that employee is compacted", async () => {
    const viewer = await person();
    const teammate = await person();
    const writer = await employee(viewer, "写手");
    const reviewer = await employee(viewer, "审核");
    const channelId = `${suite}-group-${randomUUID()}`;
    channelIds.push(channelId);
    const mine = randomUUID();
    const other = randomUUID();
    await runAsTenant(viewer, async () => {
      await database
        .insert(channels)
        .values({ id: channelId, name: "群组", description: "" });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: viewer });
      await database.insert(channelAgents).values([
        { channelId, agentId: writer },
        { channelId, agentId: reviewer },
      ]);
      await database
        .insert(groupBotThreads)
        .values([
          { ownerUserId: viewer, channelId, agentId: writer, threadId: mine },
        ]);
      await database.insert(threads).values({
        id: mine,
        agentId: writer,
        messagesSnapshot: history(20),
      });
    });
    await runAsTenant(teammate, async () => {
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: teammate });
      await database.insert(groupBotThreads).values({
        ownerUserId: teammate,
        channelId,
        agentId: writer,
        threadId: other,
      });
    });
    const summarize = fakeSummarize("群组摘要。");
    const routes = routesFor(viewer, summarize);
    // 群组按频道压必须说是哪位员工。
    expect((await routes.channel(channelId)).status).toBe(404);
    const response = await routes.channel(channelId, writer);
    expect(response.status).toBe(200);
    const [row] = await compactionRows(viewer, mine);
    expect(row).toMatchObject({
      tenantId: viewer,
      threadId: mine,
      agentId: writer,
    });
    // 按自己那条线程问也行；别人的那条 404；还没开过线程的员工没有可压的。
    expect((await routes.thread(other)).status).toBe(404);
    expect(await routes.channel(channelId, reviewer)).toEqual({
      status: 409,
      body: expect.objectContaining({ reason: "too_short" }),
    });
    expect((await routesFor(teammate, summarize).thread(mine)).status).toBe(
      404,
    );
  });
});

describe("reading a compaction back", () => {
  test("看摘要: the summary, how many messages it replaced, and the sidebar's lastCompaction", async () => {
    const viewer = await person();
    const stranger = await person();
    const agentId = await employee(viewer, "助理");
    const messages = history(20);
    const { threadId, channelId } = await directChat(viewer, agentId, messages);
    const summarize = fakeSummarize("第一次摘要。", "第二次摘要。");
    const routes = routesFor(viewer, summarize);
    const first = await routes.thread(threadId);
    expect(first.status).toBe(200);
    const id = first.body.compactionId as string;

    const read = await routes.summaryInThread(threadId, id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      summary: "第一次摘要。",
      summarizedCount: 10,
      auto: false,
    });
    expect(typeof read.body.at).toBe("string");
    // 按频道问同一条也行（单聊频道）。
    expect((await routes.summaryInChannel(channelId, id)).body).toMatchObject({
      summary: "第一次摘要。",
    });
    const sidebar = await routes.sidebar(threadId);
    expect(
      (sidebar.body.context as { lastCompaction?: unknown }).lastCompaction,
    ).toMatchObject({
      id,
      auto: false,
      summarizedCount: 10,
      // 分隔线画在被替代的最后一条后面：20 条保留最近 10 条，替代到第 10 条。
      uptoMessageId: messages[9]?.id,
    });

    // 再压一次：被替代的条数含上一次替代的。
    const more = [...messages, ...history(12, "n")];
    await runAsTenant(viewer, () =>
      database
        .update(threads)
        .set({ messagesSnapshot: more })
        .where(eq(threads.id, threadId)),
    );
    const second = await routes.thread(threadId);
    expect(
      (
        await routes.summaryInThread(
          threadId,
          second.body.compactionId as string,
        )
      ).body,
    ).toMatchObject({ summary: "第二次摘要。", summarizedCount: 22 });

    // 看不到的人、不像 id 的 id、别的线程上的记录：都是 404。
    const notFound = {
      status: 404,
      body: { error: "Conversation not found." },
    };
    expect(
      await routesFor(stranger, summarize).summaryInThread(threadId, id),
    ).toEqual(notFound);
    expect(await routes.summaryInThread(threadId, "not-a-uuid")).toEqual(
      notFound,
    );
    const other = await directChat(viewer, agentId, history(3));
    expect(await routes.summaryInThread(other.threadId, id)).toEqual(notFound);
  });

  test("group: only the viewer reads the summary of their own thread with that employee", async () => {
    const viewer = await person();
    const teammate = await person();
    const writer = await employee(viewer, "写手");
    const reviewer = await employee(viewer, "审核");
    const channelId = `${suite}-group-${randomUUID()}`;
    channelIds.push(channelId);
    const mine = randomUUID();
    await runAsTenant(viewer, async () => {
      await database
        .insert(channels)
        .values({ id: channelId, name: "群组", description: "" });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: viewer });
      await database.insert(channelAgents).values([
        { channelId, agentId: writer },
        { channelId, agentId: reviewer },
      ]);
      await database.insert(groupBotThreads).values({
        ownerUserId: viewer,
        channelId,
        agentId: writer,
        threadId: mine,
      });
      await database.insert(threads).values({
        id: mine,
        agentId: writer,
        messagesSnapshot: history(20),
      });
    });
    await runAsTenant(teammate, () =>
      database
        .insert(channelMemberships)
        .values({ channelId, userId: teammate }),
    );
    const summarize = fakeSummarize("群组摘要。");
    const compacted = await routesFor(viewer, summarize).channel(
      channelId,
      writer,
    );
    const id = compacted.body.compactionId as string;
    expect(
      (await routesFor(viewer, summarize).summaryInChannel(channelId, id)).body,
    ).toMatchObject({ summary: "群组摘要。", summarizedCount: 10 });
    expect(
      (await routesFor(teammate, summarize).summaryInChannel(channelId, id))
        .status,
    ).toBe(404);
  });
});

describe("employees whose context is not ours", () => {
  test("a remote employee: the sidebar says who manages it and shows no usage, and compaction is 409", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "远程助理", {
      type: "remote_ag_ui",
    });
    const { threadId } = await directChat(viewer, agentId, history(20));
    const model = await libraryModel(viewer, 100_000);
    await call({
      tenantId: viewer,
      threadId,
      agentId,
      inputTokens: 95_000,
      modelRef: model,
    });
    const summarize = fakeSummarize("不该被调用。");
    const routes = routesFor(viewer, summarize);
    const sidebar = await routes.sidebar(threadId);
    expect(sidebar.status).toBe(200);
    expect(sidebar.body.context).toEqual({ managedBy: "对方系统" });
    expect(await routes.thread(threadId)).toEqual({
      status: 409,
      body: expect.objectContaining({ reason: "external" }),
    });
    expect(summarize.prompts).toHaveLength(0);
  });
});

describe("the manual route never answers a bare 500", () => {
  test("an unexpected failure (the lock connection, a write) is a 502 with reason failed", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const { threadId } = await directChat(viewer, agentId, history(20));
    const errors = console.error;
    console.error = () => {};
    const response = await routesFor(viewer, fakeSummarize("摘要。"), {
      lock: async () => {
        throw new Error("connection refused");
      },
    })
      .thread(threadId)
      .finally(() => {
        console.error = errors;
      });
    expect(response).toEqual({
      status: 502,
      body: expect.objectContaining({ reason: "failed" }),
    });
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });
});

describe("the compaction call", () => {
  test("the compaction call is metered on this thread", async () => {
    const viewer = await person();
    const agentId = await employee(viewer, "助理");
    const { threadId } = await directChat(viewer, agentId, history(20));
    const fake = new MockLanguageModelV3({
      provider: "fake",
      modelId: "fake-summary",
      doGenerate: async () => ({
        content: [{ type: "text", text: "模型写的摘要。" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 1_200,
            noCache: 1_200,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 30, text: 30, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const summarize = modelSummarizer(async (id) =>
      meteredDeploymentModel(
        {
          model: fake,
          provider: "openai",
          modelName: "gpt-default",
          baseUrl: null,
          apiKey: "synthetic",
        },
        id,
        databaseTokenCallSink(database),
      ),
    );
    // 之前一轮的真实用量。
    const model = await libraryModel(viewer, 100_000);
    await call({
      tenantId: viewer,
      threadId,
      agentId,
      inputTokens: 50_000,
      modelRef: model,
    });
    const result = await compactThread(
      { tenantId: viewer, threadId, agentId, auto: false },
      depsWith(summarize),
    );
    expect(result.status).toBe("compacted");
    const [row] = await compactionRows(viewer, threadId);
    expect(row?.summary).toBe("模型写的摘要。");

    const metered = async () =>
      runAsTenant(viewer, () =>
        database
          .select()
          .from(modelTokenCalls)
          .where(
            and(
              eq(modelTokenCalls.tenantId, viewer),
              eq(modelTokenCalls.sdkModelId, "fake-summary"),
            ),
          ),
      );
    let rows = await metered();
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await Bun.sleep(20);
      rows = await metered();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      threadId,
      agentId,
      outcome: "completed",
      inputTokens: 1_200,
    });
    expect(rows[0]?.runId.startsWith(COMPACTION_RUN_PREFIX)).toBe(true);
    // 侧栏的「已用」仍是员工那一轮的上下文，不是总结那次调用的输入。
    const usage = await readContextUsage(viewer, threadId, agentId, {
      database,
      contextWindowFor: async () => undefined,
    });
    expect(usage.used).toBe(50_000);
  });
});

describe("auto compaction before a turn", () => {
  const reviewer = (id: string) => ({
    id,
    name: "Reviewer",
    type: "built_in" as const,
    systemPrompt: "Review the code.",
  });

  /** 用 LLMock 当服务商真跑一轮内置员工，带上压缩；返回发给服务商的请求和运行事件。 */
  async function turn(input: {
    tenantId: string;
    agentId: string;
    threadId: string;
    messages: Message[];
    summarize: Summarize;
    autoTimeoutMs?: number;
    /** 这么久之后按 Stop（`abortRun()`，生产里 `runner.stop()` 走的就是它）。 */
    stopAfterMs?: number;
    /** 部署开关 `SIDEBAR_AUTO_COMPACTION`；不给时按 `runCompaction` 的默认（开）。 */
    auto?: boolean;
  }) {
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const events: BaseEvent[] = [];
    let sent = "";
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, { content: "AUTO001 fixture completed." });
      const deps = depsWith(input.summarize);
      const built = await runAsTenant(input.tenantId, () =>
        buildAgents(
          [reviewer(input.agentId)],
          { provider: "openai", defaultModel: "gpt-5.6-terra" },
          "synthetic-deployment-key",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          contextBreakdownRecorder(database, input.tenantId),
          runCompaction({
            ...deps,
            tenantId: input.tenantId,
            ...(input.auto === undefined ? {} : { auto: input.auto }),
            ...(input.autoTimeoutMs
              ? { autoTimeoutMs: input.autoTimeoutMs }
              : {}),
          }),
        ),
      );
      const agent = built[input.agentId]?.clone() as AbstractAgent | undefined;
      if (!agent) throw new Error("buildAgents returned no agent");
      agent.threadId = input.threadId;
      for (const message of input.messages) agent.addMessage(message);
      const stop =
        input.stopAfterMs === undefined
          ? undefined
          : setTimeout(() => agent.abortRun(), input.stopAfterMs);
      await runAsTenant(input.tenantId, () =>
        agent.runAgent(
          { runId: `run-${randomUUID()}` },
          { onEvent: ({ event }) => void events.push(event) },
        ),
      );
      clearTimeout(stop);
      sent = JSON.stringify(recorder.getRequests().map((entry) => entry.body));
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
    const notices = events.filter((event) => event.type === EventType.CUSTOM);
    return { sent, events, notices };
  }

  async function nearlyFull(used: number, contextWindow: number | null) {
    const viewer = await person();
    const model = await libraryModel(viewer, contextWindow);
    const agentId = await employee(viewer, "Reviewer", { modelRef: model });
    const threadId = randomUUID();
    await call({
      tenantId: viewer,
      threadId,
      agentId,
      inputTokens: used,
      modelRef: model,
    });
    return { viewer, agentId, threadId };
  }

  test("auto compaction runs before a turn when used >= limit - reserve", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(90_000, 100_000);
    const messages = [
      ...history(20),
      { id: "now", role: "user" as const, content: "接着做吧。" },
    ];
    const summarize = fakeSummarize("SUMMARY-AUTO：用户定了方案 B。");
    const { sent, notices } = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages,
      summarize,
    });
    expect(summarize.prompts).toHaveLength(1);
    const [row] = await compactionRows(viewer, threadId);
    expect(row).toMatchObject({ agentId, auto: true, uptoMessageId: "m10" });
    // 摘要真的发给了模型，被它替换的早先消息没有发。
    expect(sent).toContain("SUMMARY-AUTO：用户定了方案 B。");
    expect(sent).not.toContain("用户第 0 句");
    expect(sent).toContain("员工第 11 句");
    expect(sent).toContain("接着做吧。");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      name: COMPACTION_DONE_EVENT,
      value: { auto: true, compactionId: row?.id },
    });

    // 这一轮的分类比例把摘要算在消息里。
    const breakdowns = async () =>
      runAsTenant(viewer, () =>
        database
          .select()
          .from(threadContextBreakdowns)
          .where(eq(threadContextBreakdowns.threadId, threadId)),
      );
    let rows = await breakdowns();
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await Bun.sleep(20);
      rows = await breakdowns();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shares.messages).toBeGreaterThan(0);

    // 同一个「上一轮」用量，压过之后下一轮不再压。
    const next = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages: [...messages, { id: "later", role: "user", content: "再来。" }],
      summarize,
    });
    expect(summarize.prompts).toHaveLength(1);
    expect(next.notices).toHaveLength(0);
    expect(next.sent).toContain("SUMMARY-AUTO");
    expect(await compactionRows(viewer, threadId)).toHaveLength(1);
  });

  test("below the threshold the turn runs uncompacted", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(89_999, 100_000);
    const summarize = fakeSummarize("不该被调用。");
    const { sent, notices } = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages: history(21),
      summarize,
    });
    expect(summarize.prompts).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(sent).toContain("用户第 0 句");
  });

  test("no limit → never auto-compacts", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(5_000_000, null);
    const summarize = fakeSummarize("不该被调用。");
    const { notices } = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages: history(21),
      summarize,
    });
    expect(summarize.prompts).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("a failed auto compaction does not block the turn and says so once", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(95_000, 100_000);
    const errors = console.error;
    console.error = () => {};
    let result: Awaited<ReturnType<typeof turn>>;
    try {
      result = await turn({
        tenantId: viewer,
        agentId,
        threadId,
        messages: history(21),
        summarize: fakeSummarize(async () => {
          throw new Error("provider down");
        }),
      });
    } finally {
      console.error = errors;
    }
    expect(result.events.map((event) => event.type)).toContain(
      EventType.RUN_FINISHED,
    );
    expect(result.sent).toContain("用户第 0 句");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({
      name: COMPACTION_FAILED_EVENT,
      value: { auto: true },
    });
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("an auto compaction that takes too long is skipped and the turn runs", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(95_000, 100_000);
    let aborted = false;
    const summarize: Summarize = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const errors = console.error;
    console.error = () => {};
    let result: Awaited<ReturnType<typeof turn>>;
    const started = Date.now();
    try {
      result = await turn({
        tenantId: viewer,
        agentId,
        threadId,
        messages: history(21),
        summarize,
        autoTimeoutMs: 200,
      });
    } finally {
      console.error = errors;
    }
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.events.map((event) => event.type)).toContain(
      EventType.RUN_FINISHED,
    );
    expect(result.sent).toContain("用户第 0 句");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ name: COMPACTION_FAILED_EVENT });
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("Stop during an auto compaction aborts the summary, writes nothing and ends the turn", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(95_000, 100_000);
    let aborted = false;
    const summarize: Summarize = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const errors = console.error;
    console.error = () => {};
    let result: Awaited<ReturnType<typeof turn>>;
    const started = Date.now();
    try {
      result = await turn({
        tenantId: viewer,
        agentId,
        threadId,
        messages: history(21),
        summarize,
        stopAfterMs: 300,
      });
    } finally {
      console.error = errors;
    }
    expect(aborted).toBe(true);
    // 远早于 30 秒的上限：是 Stop 停住的，不是超时。
    expect(Date.now() - started).toBeLessThan(10_000);
    // 被停下的这一轮不再调用模型，开始和结束照常报完。
    expect(result.sent).toBe("[]");
    const types = result.events.map((event) => event.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);
  });

  test("the SIDEBAR_AUTO_COMPACTION switch: off never auto-compacts (a manual summary still applies), on compacts", async () => {
    const { viewer, agentId, threadId } = await nearlyFull(95_000, 100_000);
    const messages = [
      ...history(20),
      { id: "now", role: "user" as const, content: "接着做吧。" },
    ];
    const summarize = fakeSummarize("SUMMARY-SWITCH：开关打开后压的。");

    const off = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages,
      summarize,
      auto: false,
    });
    expect(summarize.prompts).toHaveLength(0);
    expect(off.notices).toHaveLength(0);
    expect(off.sent).toContain("用户第 0 句");
    expect(await compactionRows(viewer, threadId)).toHaveLength(0);

    // 关着的时候，手动压缩留下的摘要照样换进这一轮。
    await runAsTenant(viewer, () =>
      database.insert(threadCompactions).values({
        threadId,
        agentId,
        uptoMessageId: "m5",
        summary: "MANUAL-SUMMARY：手动压的。",
        auto: false,
        // 早于那次用量的调用：用量不是「压过之后的旧数」，开关打开时照样该压。
        createdAt: new Date(clock - 60_000),
      }),
    );
    const manual = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages,
      summarize,
      auto: false,
    });
    expect(summarize.prompts).toHaveLength(0);
    expect(manual.sent).toContain("MANUAL-SUMMARY：手动压的。");
    expect(manual.sent).not.toContain("用户第 0 句");

    // 开关打开：同样的用量照旧自动压缩。
    const on = await turn({
      tenantId: viewer,
      agentId,
      threadId,
      messages,
      summarize,
      auto: true,
    });
    expect(summarize.prompts).toHaveLength(1);
    expect(on.notices[0]).toMatchObject({ name: COMPACTION_DONE_EVENT });
    expect(on.sent).toContain("SUMMARY-SWITCH：开关打开后压的。");
  });
});
