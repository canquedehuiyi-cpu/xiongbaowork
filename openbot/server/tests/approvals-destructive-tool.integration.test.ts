import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { DESTRUCTIVE_TOOL_REASON } from "../src/approvals/policy";
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
});
await runAsTenant("platform", () =>
  plugins.addInstallListing("mcp", server, "ops@destructive.test"),
);
await runAsTenant(person, () =>
  plugins.recordConnection({
    serverId: server,
    userId: person,
    refreshToken: `rt-${person}`,
    scope: "write",
  }),
);
await runAsTenant(person, () =>
  plugins.grant("mcp", RESET, avatarAgentId(person), email, {
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
  await runAsTenant("platform", () =>
    plugins.removeInstallListing("mcp", server, "ops@destructive.test"),
  );
  await runAsTenant("platform", () =>
    database.delete(mcpServers).where(eq(mcpServers.id, server)),
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
