import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createApprovalService,
  DECLINED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  ApprovalRefusedError,
  withApprovalContext,
} from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What the trail says about an app write when "Ask before making changes" is on (upstream #1106,
 * the plugin store's half). The write asks first, through the approval gate; a denial is recorded as
 * that app call refused, written when the person says no, and a retry the gate turns away is
 * recorded too. Neither ever reaches the vendor. A real plugin store and approval store over the
 * real tables, in the person's own tenant frame; the vendor is the `callVendor` seam.
 *
 * (The computer gateway's file actions are not covered here: this fork's gateway does not yet ask
 * the gate before it records the attempt.)
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `audit-outcomes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createApprovalStore(database);
/** The person's own answers are given in their own frame, as their signed-in requests are. */
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
const service = createApprovalService(store);

const APP = `${prefix}-notes`;
const APP_BOT = `${prefix}-app-bot`;
const APP_TOOL = `${APP}/create_note`;
const vendorCalls: string[] = [];
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => service.gate(candidate),
  callVendor: async (_connection, toolName) => {
    vendorCalls.push(toolName);
    return { text: "created", isError: false };
  },
});

/** Every row this Bot's app calls and decisions left, oldest first. */
const trailFor = (bot: string) =>
  runAsTenant("platform", () =>
    database
      .select({
        eventType: auditEvents.eventType,
        tenantId: auditEvents.tenantId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(sql<string>`${auditEvents.payload} ->> 'bot'`, bot))
      .orderBy(asc(auditEvents.createdAt)),
  );

function appCall(threadId: string): ApprovalContinuation {
  const toolCallId = randomUUID();
  const args = { title: "needle-argument-value-8803" };
  return {
    runId: randomUUID(),
    threadId,
    toolCallId,
    toolName: `mcp__${APP}__create_note`,
    args,
    messages: [{ id: "u1", role: "user", content: "Make a note for Friday" }],
    state: {},
    context: [],
    forwardedProps: {},
  };
}
const callApp = (continuation: ApprovalContinuation) =>
  asOwner(() =>
    withApprovalContext(continuation, () =>
      plugins.callTool({
        ref: APP_TOOL,
        args: continuation.args as Record<string, unknown>,
        botId: APP_BOT,
        actorId: owner,
      }),
    ),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  // An app's catalogue entry is the team's, stamped `team`, which every person's frame reads.
  await runAsTenant("platform", async () => {
    await database.insert(mcpServers).values({
      tenantId: "team",
      id: APP,
      title: "Team Notes",
      vendor: "Acme",
      url: "https://notes.example.test/mcp",
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      tenantId: "team",
      serverId: APP,
      name: "create_note",
      vendorName: "create_note",
      inputSchema: {},
      effect: "write",
    });
  });
  // The Bot and its grant are the person's own.
  await asOwner(async () => {
    await database.insert(agents).values({
      id: APP_BOT,
      name: "Notes",
      type: "built_in",
      configuration: {},
    });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: APP_TOOL, agentId: APP_BOT });
  });
  await asOwner(() => store.setEnabled(owner, true));
});
afterAll(async () => {
  const ids = (await asOwner(() => store.list(owner))).map(
    (request) => request.id,
  );
  if (ids.length)
    await asOwner(() =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, ids),
          ),
        ),
    );
  await asOwner(() => database.delete(agents).where(eq(agents.id, APP_BOT)));
  await runAsTenant("platform", () =>
    database.delete(mcpServers).where(eq(mcpServers.id, APP)),
  );
  await runAsTenant("platform", () =>
    database.delete(users).where(eq(users.id, owner)),
  );
  await database.$client.close();
});

test("an app write the person denies is on the trail as a refused call, written when they say no, and so is a retry", async () => {
  const threadId = `${prefix}-app-${randomUUID()}`;
  const asked = await callApp(appCall(threadId));
  expect(asked).toBeInstanceOf(HeadlessToolSuspension);
  const [request] = (await asOwner(() => store.list(owner))).filter(
    (row) => row.action.threadId === threadId,
  );
  if (!request) throw new Error("the app write was not asked about");

  // Asked, and nothing written yet: no row may say the call was refused, or carried out.
  const calls = async () =>
    (await trailFor(APP_BOT)).filter((row) =>
      row.eventType.startsWith("mcp.call_"),
    );
  expect(await calls()).toEqual([]);

  await asOwner(() => service.decide(owner, request.id, "deny"));
  expect((await calls()).map((row) => row.eventType)).toEqual([
    "mcp.call_rejected",
  ]);

  // The Bot tries the same thing again before the person has said anything more.
  const retried = await callApp(appCall(threadId));
  expect(retried).toBeInstanceOf(ApprovalRefusedError);
  expect(vendorCalls).toEqual([]);

  const rows = await calls();
  expect(rows.map((row) => row.eventType)).toEqual([
    "mcp.call_rejected",
    "mcp.call_rejected",
  ]);
  expect(
    rows.map((row) => (row.payload as { refusal?: string }).refusal),
  ).toEqual(["person_declined", "approval"]);
  for (const row of rows) {
    expect(row.payload).toMatchObject({
      tool: "create_note",
      decision: { carriedOut: false },
      reason: DECLINED_BY_PERSON,
    });
    // The person's own tenant, never the arguments.
    expect(row.tenantId).toBe(owner);
  }
  expect(JSON.stringify(rows)).not.toContain("needle-argument-value-8803");
  // The person's decision row sits beside the refusal.
  expect(
    (await trailFor(APP_BOT)).filter(
      (row) => row.eventType === "approval.person_decided",
    ),
  ).toHaveLength(1);
});

test("an app write the person allows is carried out and recorded as it was, with no refused row", async () => {
  const threadId = `${prefix}-app-${randomUUID()}`;
  const continuation = appCall(threadId);
  expect(await callApp(continuation)).toBeInstanceOf(HeadlessToolSuspension);
  const [allowed] = (await asOwner(() => store.list(owner))).filter(
    (row) => row.action.threadId === threadId,
  );
  if (!allowed) throw new Error("the second app write was not asked about");
  await asOwner(() => service.decide(owner, allowed.id, "allow_once"));
  // The same call comes back once the person has said yes, and is carried out.
  expect(await callApp(continuation)).toBeUndefined();
  expect(vendorCalls).toEqual(["create_note"]);

  expect(
    (await trailFor(APP_BOT))
      .filter((row) => row.eventType.startsWith("mcp.call_"))
      .map((row) => row.eventType),
  ).toEqual(["mcp.call_rejected", "mcp.call_rejected", "mcp.call_succeeded"]);
});
