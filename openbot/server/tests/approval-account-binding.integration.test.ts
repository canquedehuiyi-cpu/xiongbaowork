import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import * as extraColumns from "../src/approvals/extra-columns";
import { conversationGrant, strictestRule } from "../src/approvals/policy";
import { recordedActions } from "../src/approvals/rule-backtest";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  type ApprovalConversationGrant,
  type ApprovalRecord,
  approvalAction,
} from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredAccounts, users } from "../src/db/schema";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import { approvalRules } from "../src/db/schema/approvals";
import { workItems } from "../src/db/schema/work";
import {
  accountBinding,
  createAccountBook,
  type PinnedAccount,
} from "../src/plugins/brokered-accounts";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 多账号的审批接到 M5a 的审批扩展列上（X1 在 M5a 合入后补的接线）。
 *
 * - `approval_rules.account` 和 `kind` 一样由 `approvals/extra-columns.ts` 读写：`ruleColumns` 带上它，
 *   「这里始终允许」在同一条语句里写下种类与账号，规则列表读回它。
 * - 规则与「在这段对话里都允许」绑定账号的稳定绑定（vendor 报的地址，没有时是账号行的 id），不绑定会随
 *   位置变的名字「账号 N」：断开前面一个账号后，为后面那个保存的规则仍然只管它（X1 评审 M1）。
 * - 「在这段对话里都允许」只回答同一个账号（M5a 预留的 `conversationGrant`）。
 * - 规则回放按请求的账号回放（M5a 预留的 `rule-backtest`）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-binding-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createApprovalStore(database);
const keys: string[] = [];
const app = `${prefix}-gmail`;
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values([{ id: owner, email: `${owner}@example.test` }]),
  );
  await asOwner(() => store.setEnabled(owner, true));
});

afterAll(async () => {
  await asOwner(async () => {
    if (keys.length)
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, keys),
          ),
        );
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.userId, owner));
  });
  await runAsTenant("platform", () =>
    database.delete(users).where(eq(users.id, owner)),
  );
  await database.$client.close();
});

/** 主人的一次 Gmail 读信，进 `account` 那个账号；其余每次都一样。 */
function read(
  account?: { account: string; accountBinding?: string },
  threadId = `${prefix}-thread`,
): ApprovalCandidate {
  const args = { query: "from:pat" };
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "gmail/GMAIL_FETCH_EMAILS",
    effect: "read",
    scope: "gmail",
    args,
    target: { serverId: "gmail", toolName: "GMAIL_FETCH_EMAILS" },
    ...(account ?? {}),
    continuation: {
      runId: randomUUID(),
      threadId,
      toolCallId: randomUUID(),
      toolName: "gmail__GMAIL_FETCH_EMAILS",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}

test("approval_rules.account is read and written through approvals/extra-columns", () => {
  const columns = extraColumns as Record<string, unknown>;
  expect(Object.keys(columns.ruleColumns as object)).toEqual([
    ...Object.keys(getTableColumns(approvalRules)),
    "kind",
    "account",
  ]);
  expect(typeof columns.ruleAccount).toBe("object");
  expect(typeof columns.saveRuleExtras).toBe("function");
});

test("Always allow here saves the account's binding and the card's kind in one write, and the rule list reads it back", async () => {
  const binding = "row:11111111-1111-4111-8111-111111111111";
  const first = await asOwner(() =>
    store.open(
      approvalAction(read({ account: "账号 2", accountBinding: binding })),
    ),
  );
  keys.push(first.id);
  await asOwner(() => store.decide(owner, first.id, "allow_always"));

  const rules = await asOwner(() => store.rules(owner));
  expect(rules.map((rule) => rule.account)).toEqual([binding]);

  // 同一个绑定、名字已经变成「账号 1」（前面的账号断开了）：仍是那条规则放行。
  const renamed = await asOwner(() =>
    store.open(
      approvalAction(read({ account: "账号 1", accountBinding: binding })),
    ),
  );
  keys.push(renamed.id);
  expect(renamed.status).toBe("approved");

  // 名字还是「账号 2」、却是另一个账号：不放行。
  const other = await asOwner(() =>
    store.open(
      approvalAction(
        read({
          account: "账号 2",
          accountBinding: "row:22222222-2222-4222-8222-222222222222",
        }),
      ),
    ),
  );
  keys.push(other.id);
  expect(other.status).toBe("pending");
  expect(
    strictestRule(
      read({
        account: "账号 2",
        accountBinding: "row:22222222-2222-4222-8222-222222222222",
      }),
      [],
      rules,
    ),
  ).toBeUndefined();
  expect(
    strictestRule(
      read({ account: "账号 1", accountBinding: binding }),
      [],
      rules,
    )?.rule.behaviour,
  ).toBe("allow");
});

test("Allow for this conversation is saved for the account the card named", async () => {
  const thread = `${prefix}-conversation`;
  const binding = "dana@work.example";
  const request = await asOwner(() =>
    store.open(
      approvalAction(
        read({ account: binding, accountBinding: binding }, thread),
      ),
    ),
  );
  keys.push(request.id);
  await asOwner(() => store.decide(owner, request.id, "allow_conversation"));

  const [grant] = await asOwner(() =>
    database
      .select({ account: approvalConversationGrants.account })
      .from(approvalConversationGrants)
      .where(eq(approvalConversationGrants.approvalId, request.id)),
  );
  expect(grant?.account).toBe(binding);
});

test("an answer for this conversation covers only the account it was given for", () => {
  const grant = (account: string | null): ApprovalConversationGrant => ({
    id: randomUUID(),
    ownerUserId: owner,
    threadId: `${prefix}-thread`,
    approvalId: randomUUID(),
    botId: `${prefix}-bot`,
    toolRef: "gmail/GMAIL_FETCH_EMAILS",
    effect: "read",
    scope: "gmail",
    account,
    kind: null,
    createdAt: new Date(),
  });
  const work = { account: "dana@work.example" };
  const home = { account: "dana.home@gmail.example" };

  expect(
    conversationGrant(read(work), [grant(work.account)], undefined),
  ).toBeDefined();
  expect(
    conversationGrant(read(home), [grant(work.account)], undefined),
  ).toBeUndefined();
  // 没点名账号时给的答复，不回答点名了账号的调用；反过来也一样。
  expect(
    conversationGrant(read(work), [grant(null)], undefined),
  ).toBeUndefined();
  expect(
    conversationGrant(read(), [grant(work.account)], undefined),
  ).toBeUndefined();
  expect(conversationGrant(read(), [grant(null)], undefined)).toBeDefined();
  // 绑定按大小写不敏感比较，和规则一样。
  expect(
    conversationGrant(
      read({ account: "Dana@Work.Example" }),
      [grant(work.account)],
      undefined,
    ),
  ).toBeDefined();

  // 在最严规则里同样只对这个账号成立。
  expect(
    strictestRule(read(work), [], [], {
      conversation: [grant(work.account)],
    })?.layer,
  ).toBe("conversation");
  expect(
    strictestRule(read(home), [], [], { conversation: [grant(work.account)] }),
  ).toBeUndefined();
});

test("an account's binding stays with the account when the one before it is disconnected", async () => {
  const book = createAccountBook({
    database,
    broker: undefined,
    auditStore: createAuditStore(database),
  });
  const [first, second] = await asOwner(() =>
    database
      .insert(brokeredAccounts)
      .values([
        {
          provider: "composio",
          app,
          userId: owner,
          vendorUserId: owner,
          accountId: "ca_first",
          isDefault: true,
          connectedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          provider: "composio",
          app,
          userId: owner,
          vendorUserId: owner,
          accountId: "ca_second",
          isDefault: false,
          connectedAt: new Date("2026-02-01T00:00:00Z"),
        },
      ])
      .returning(),
  );
  if (!first || !second) throw new Error("accounts were not written");
  const pick = (named: string) =>
    asOwner(() =>
      book.pick({ toolkit: app, title: "Gmail", userId: owner, named }),
    );

  const before = (await pick("账号 2")) as PinnedAccount;
  expect(before.label).toBe("账号 2");
  expect(before.accountId).toBe("ca_second");
  expect(before.binding).toBe(`row:${second.id}`);
  expect(before.binding).toBe(accountBinding(second));

  await asOwner(() =>
    database.delete(brokeredAccounts).where(eq(brokeredAccounts.id, first.id)),
  );
  const after = (await pick("账号 1")) as PinnedAccount;
  expect(after.accountId).toBe("ca_second");
  expect(after.label).toBe("账号 1");
  expect(after.binding).toBe(before.binding);

  // 有地址的账号按地址绑定。
  expect(accountBinding({ id: "x", identity: "dana@work.example" })).toBe(
    "dana@work.example",
  );
});

test("a rule replay replays a request for the account it was for", () => {
  const candidate = read({
    account: "账号 2",
    accountBinding: "row:33333333-3333-4333-8333-333333333333",
  });
  const request: ApprovalRecord = {
    id: randomUUID(),
    ownerUserId: owner,
    action: approvalAction(candidate),
    status: "pending",
    decision: null,
    result: null,
    createdAt: new Date(),
    decidedAt: null,
    consumedAt: null,
    completedAt: null,
  } as ApprovalRecord;
  const [replayed] = recordedActions([], [request]);
  expect(replayed?.account).toBe("row:33333333-3333-4333-8333-333333333333");
});
