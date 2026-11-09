import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  DESTRUCTIVE_TOOL_REASON,
  OUTBOUND_SEND_REASON,
} from "../src/approvals/policy";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  offersStandingRule,
  withApprovalContext,
} from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRules,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
  subscriptions,
  users,
} from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 删除类底线，从一次真实的 MCP 调用走到审批卡片：`mcp_tools.destructive` 为真的工具，插件仓库把
 * 这个事实交给 SEC1 审批门，审批门在主人「总是允许」的规则之上仍然要问，存下的请求只接受「允许
 * 一次」或拒绝。真实数据库、行级安全、真实的插件仓库和审批服务；厂商是替身，这里什么都不会发出去。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const person = `dtool-${suite}`;
const email = `${person}@destructive.test`;
const server = `dtool${suite}`;
/** 名字里看不出会删除什么，只有应用自己的标注说它会。 */
const RESET = `${server}/reset_pipeline`;
/** 把内容发给别人的应用工具：对外发送底线一律先问。 */
const SEND = `${server}/send_email`;
/**
 * 管理员按 URL 添加、起名撞上内部前缀的自定义服务器（官方参考实现 server-memory 就叫 memory）。
 * id 就是这两个字面值，所以开跑前先确认库里没有同名的行，免得删到别人的。
 */
const LOOKALIKES = ["memory", "host"] as const;

const approvalStore = createApprovalStore(database);
const approvals = createApprovalService(approvalStore);
const vendorCalls: string[] = [];
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  // 与 index.ts 一样：每次连接器调用都过 SEC1 审批门。
  approvalGate: approvals.gate,
  callVendor: async (_connection, toolName) => {
    vendorCalls.push(toolName);
    return { text: "[vendor not reached in tests]", isError: false };
  },
});

await runAsTenant(person, () =>
  database
    .insert(users)
    .values({ id: person, email, name: person })
    .onConflictDoNothing(),
);
await provisionTenant(database, { id: person, email });
await runAsTenant("platform", async () => {
  await database.insert(mcpServers).values({
    id: server,
    tenantId: "team",
    title: "客户管理（测试）",
    vendor: "Test",
    url: `https://${server}.example.test/mcp`,
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    tenantId: "team",
    serverId: server,
    name: "reset_pipeline",
    description: "Reset a sales pipeline.",
    effect: "write",
    destructive: true,
  });
  await database.insert(mcpTools).values({
    tenantId: "team",
    serverId: server,
    name: "send_email",
    description: "Send an email to a customer.",
    effect: "write",
  });
});
await runAsTenant("platform", async () => {
  const taken = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(inArray(mcpServers.id, [...LOOKALIKES]));
  if (taken.length)
    throw new Error(
      `this database already has servers called ${taken.map((row) => row.id).join(", ")}; refusing to reuse them`,
    );
  for (const id of LOOKALIKES) {
    await database.insert(mcpServers).values({
      id,
      tenantId: "team",
      title: `${id}（测试）`,
      vendor: "Test",
      url: `https://${id}-${suite}.example.test/mcp`,
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      tenantId: "team",
      serverId: id,
      name: "delete_entities",
      description: "Delete entities from the knowledge graph.",
      effect: "write",
    });
  }
});
for (const id of [server, ...LOOKALIKES])
  await runAsTenant("platform", () =>
    plugins.addInstallListing("mcp", id, "ops@destructive.test"),
  );
await runAsTenant(person, () =>
  plugins.recordConnection({
    serverId: server,
    userId: person,
    refreshToken: `rt-${person}`,
    scope: "write",
  }),
);
for (const ref of [
  RESET,
  SEND,
  ...LOOKALIKES.map((id) => `${id}/delete_entities`),
])
  await runAsTenant(person, () =>
    plugins.grant("mcp", ref, avatarAgentId(person), email, {
      selfService: true,
    }),
  );

afterAll(async () => {
  await runAsTenant(person, async () => {
    const ids = (await approvalStore.list(person)).map((request) => request.id);
    if (ids.length)
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, ids),
          ),
        );
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, avatarAgentId(person)));
    await database
      .delete(approvalRules)
      .where(eq(approvalRules.ownerUserId, person));
  });
  for (const id of [server, ...LOOKALIKES])
    await runAsTenant("platform", () =>
      plugins.removeInstallListing("mcp", id, "ops@destructive.test"),
    );
  await runAsTenant("platform", () =>
    database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [server, ...LOOKALIKES])),
  );
  await runAsTenant(person, async () => {
    await database.delete(credentials).where(eq(credentials.keyId, person));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.tenantId, person));
    await database.delete(agents).where(eq(agents.tenantId, person));
    await database
      .delete(subscriptions)
      .where(eq(subscriptions.tenantId, person));
    await database.delete(users).where(eq(users.id, person));
  });
  await database.$client.end({ timeout: 5 });
});

test("一次 MCP 调用：应用标为破坏性的工具在「总是允许」规则之上仍要问，且只能「允许一次」", async () => {
  // 主人允许这个 Bot 不问就做任何事。
  await runAsTenant(person, () =>
    approvals.createRule(person, {
      botId: "*",
      toolRef: "*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    }),
  );
  const toolCallId = randomUUID();
  const context: ApprovalContinuation = {
    runId: randomUUID(),
    threadId: `${person}-thread`,
    toolCallId,
    toolName: RESET,
    args: {},
    messages: [{ id: "u1", role: "user", content: "把销售管道重置一下。" }],
    state: {},
    context: [],
    forwardedProps: {},
  };
  const thrown = await runAsTenant(person, () =>
    withApprovalContext(context, () =>
      plugins.callTool({
        ref: RESET,
        args: {},
        botId: avatarAgentId(person),
        actorId: person,
      }),
    ),
  ).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(HeadlessToolSuspension);
  expect(vendorCalls).toEqual([]);

  const [request] = (
    await runAsTenant(person, () => approvalStore.list(person))
  ).filter((row) => row.action.toolCallId === toolCallId);
  expect(request?.status).toBe("pending");
  expect(request?.action.destructive).toBeTrue();
  expect(request?.action.policy).toMatchObject({
    behaviour: "ask",
    source: "destructive_tool",
    reason: DESTRUCTIVE_TOOL_REASON,
  });
  expect(offersStandingRule(request?.action ?? {})).toBeFalse();

  const rulesBefore = await runAsTenant(person, () =>
    approvalStore.rules(person),
  );
  await expect(
    runAsTenant(person, () =>
      approvals.decide(person, request?.id as string, "allow_always"),
    ),
  ).rejects.toThrow("只能「允许一次」或拒绝");
  // 拒掉的「总是允许」什么都没存，请求还在等。
  expect(await runAsTenant(person, () => approvalStore.rules(person))).toEqual(
    rulesBefore,
  );
  const once = await runAsTenant(person, () =>
    approvals.decide(person, request?.id as string, "allow_once"),
  );
  expect(once).toMatchObject({ decision: "allow_once", status: "approved" });
});

test("一次 MCP 调用：把内容发给别人的工具在「总是允许」规则之上仍要问，且只能「允许一次」", async () => {
  // 上一条测试已经存了「任何事都不问」的规则；这里再确认一次它在。
  expect(
    (await runAsTenant(person, () => approvalStore.rules(person))).some(
      (row) => row.toolRef === "*" && row.behaviour === "allow",
    ),
  ).toBeTrue();
  const toolCallId = randomUUID();
  const args = { to: "client@example.test", subject: "报价", body: "见附件" };
  const thrown = await runAsTenant(person, () =>
    withApprovalContext(
      {
        runId: randomUUID(),
        threadId: `${person}-thread-send`,
        toolCallId,
        toolName: SEND,
        args,
        messages: [{ id: "u1", role: "user", content: "把报价发给客户。" }],
        state: {},
        context: [],
        forwardedProps: {},
      },
      () =>
        plugins.callTool({
          ref: SEND,
          args,
          botId: avatarAgentId(person),
          actorId: person,
        }),
    ),
  ).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(HeadlessToolSuspension);
  expect(vendorCalls).toEqual([]);

  const [request] = (
    await runAsTenant(person, () => approvalStore.list(person))
  ).filter((row) => row.action.toolCallId === toolCallId);
  expect(request?.status).toBe("pending");
  expect(request?.action.policy).toMatchObject({
    behaviour: "ask",
    source: "outbound_send",
    reason: OUTBOUND_SEND_REASON,
  });
  expect(offersStandingRule(request?.action ?? {})).toBeFalse();
  const rulesBefore = await runAsTenant(person, () =>
    approvalStore.rules(person),
  );
  await expect(
    runAsTenant(person, () =>
      approvals.decide(person, request?.id as string, "allow_always"),
    ),
  ).rejects.toThrow("这个操作可能会把内容发给别人，每次都要你确认");
  expect(await runAsTenant(person, () => approvalStore.rules(person))).toEqual(
    rulesBefore,
  );
  expect(
    await runAsTenant(person, () =>
      approvals.decide(person, request?.id as string, "allow_once"),
    ),
  ).toMatchObject({ decision: "allow_once", status: "approved" });
});

test("一个叫 memory 或 host 的 MCP 服务器上的 delete_entities 同样要问：按调用路径认应用工具，不看名字", async () => {
  for (const id of LOOKALIKES) {
    const ref = `${id}/delete_entities`;
    const toolCallId = randomUUID();
    const thrown = await runAsTenant(person, () =>
      withApprovalContext(
        {
          runId: randomUUID(),
          threadId: `${person}-thread-${id}`,
          toolCallId,
          toolName: ref,
          args: {},
          messages: [{ id: "u1", role: "user", content: "把这些实体删掉。" }],
          state: {},
          context: [],
          forwardedProps: {},
        },
        () =>
          plugins.callTool({
            ref,
            args: {},
            botId: avatarAgentId(person),
            actorId: person,
          }),
      ),
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HeadlessToolSuspension);
    const [request] = (
      await runAsTenant(person, () => approvalStore.list(person))
    ).filter((row) => row.action.toolCallId === toolCallId);
    expect(request?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "destructive_tool",
    });
  }
  expect(vendorCalls).toEqual([]);
});

test("listForAgent 把 mcp_tools.destructive 带给模型那一侧，提供工具时才能写明会先问", async () => {
  const granted = await runAsTenant(person, () =>
    plugins.listForAgent(avatarAgentId(person)),
  );
  const byRef = new Map(granted.tools.map((tool) => [tool.ref, tool]));
  expect(byRef.get(RESET)?.destructive).toBe(true);
  expect(byRef.get("memory/delete_entities")?.destructive).toBe(false);
});

test("连接探测不调用 vendor 只字未提的动作，即使它被记成了读", async () => {
  // 正常入库时 unclassified 一定是写；这里直接写一行「读 + unclassified」，钉住探测这一层双保险。
  await runAsTenant("platform", () =>
    database.insert(mcpTools).values([
      {
        tenantId: "team",
        serverId: server,
        name: "a_unlabelled_lookup",
        description: "Nobody said what this does.",
        effect: "read",
        unclassified: true,
        version: "20261101_00",
      },
      {
        tenantId: "team",
        serverId: server,
        name: "b_list_pipelines",
        description: "List pipelines.",
        effect: "read",
        version: "20261101_00",
      },
    ]),
  );
  // 按名字排序，没有这层判断时会先挑中 a_unlabelled_lookup。
  expect(
    await runAsTenant("platform", () => plugins.probeActionFor(server)),
  ).toEqual({ name: "b_list_pipelines", version: "20261101_00" });
});
