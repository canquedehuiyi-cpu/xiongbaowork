import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { approvalPhrase, approvalWords } from "@openbot/shared/tool-name";
import { and, eq, inArray } from "drizzle-orm";
import { ruleMatches, strictestRule } from "../src/approvals/policy";
import { equivalenceOf } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  type ApprovalRule,
  approvalAction,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRules, users } from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 对一个邮箱的批准从不覆盖另一个（上游 `approvals-account.integration.test.ts`，#1298，按 fork 改写）。
 *
 * 一个人有两个 Gmail，让员工从工作邮箱发信并按了「这里始终允许」。同样的一封信从私人邮箱发出是另一个
 * 请求：它与第一个不等价，摘要不同，为工作邮箱保存的规则不放行它。卡片点名它问的是哪个账号。
 *
 * fork 的差异：规则有三层（团队、员工主人、本人），主人的规则与本人的一样按严的方向读；卡片是中文。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-account-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createApprovalStore(database);
const keys: string[] = [];
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";
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
  if (keys.length)
    await asOwner(() =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, keys),
          ),
        ),
    );
  await runAsTenant("platform", () =>
    database.delete(users).where(eq(users.id, owner)),
  );
  await database.$client.close();
});

/** 主人的一次 Gmail 发信，从 `account` 发出，其余每次都一样。 */
function send(account?: string): ApprovalCandidate {
  const args = { to: "pat@example.test", subject: "Hi", body: "See you." };
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "gmail",
    args,
    target: { serverId: "gmail", toolName: "GMAIL_SEND_EMAIL" },
    ...(account ? { account } : {}),
    continuation: {
      runId: randomUUID(),
      threadId: `${prefix}-thread`,
      toolCallId: randomUUID(),
      toolName: "gmail__GMAIL_SEND_EMAIL",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}

test("two otherwise identical calls to different accounts are different requests", () => {
  const fromWork = send(WORK);
  const fromHome = { ...send(HOME), continuation: fromWork.continuation };

  expect(equivalenceOf(fromWork)).not.toBe(equivalenceOf(fromHome));
  expect(approvalAction(fromWork).actionDigest).not.toBe(
    approvalAction(fromHome).actionDigest,
  );
  // 同一个账号两次是同一个请求，这正是比较的用途。
  expect(equivalenceOf(fromWork)).toBe(
    equivalenceOf({ ...send(WORK), continuation: fromWork.continuation }),
  );
  // 不点名账号的调用，摘要与以前一样。
  expect(equivalenceOf(send())).toBe(
    equivalenceOf({ ...send(), account: undefined }),
  );
  const plain = send();
  expect(approvalAction(plain).actionDigest).toBe(
    approvalAction({ ...plain, account: undefined }).actionDigest,
  );
});

test("Always allow here for one account is saved for that account, and does not allow another", async () => {
  const first = await asOwner(() => store.open(approvalAction(send(WORK))));
  keys.push(first.id);
  await asOwner(() => store.decide(owner, first.id, "allow_always"));

  const [saved] = await asOwner(() =>
    database
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.ownerUserId, owner)),
  );
  expect(saved?.account).toBe(WORK);

  const againFromWork = await asOwner(() =>
    store.open(approvalAction(send(WORK))),
  );
  keys.push(againFromWork.id);
  expect(againFromWork.status).toBe("approved");

  const fromHome = await asOwner(() => store.open(approvalAction(send(HOME))));
  keys.push(fromHome.id);
  expect(fromHome.status).toBe("pending");

  // 不点名账号的同一封信也不被它放行：那是另一个请求。
  const unnamed = await asOwner(() => store.open(approvalAction(send())));
  keys.push(unnamed.id);
  expect(unnamed.status).toBe("pending");

  // 策略层对同一条规则读法一致。
  const rules = await asOwner(() => store.rules(owner));
  expect(strictestRule(send(WORK), [], rules)?.rule.behaviour).toBe("allow");
  expect(strictestRule(send(HOME), [], rules)).toBeUndefined();
});

test("a personal allow rule naming no account no longer allows a call that names one; asking still holds everywhere", () => {
  const rule = (
    behaviour: ApprovalRule["behaviour"],
    account: string | null = null,
  ) => ({
    id: randomUUID(),
    botId: "*",
    toolRef: "gmail/*",
    effect: "write",
    scope: "gmail",
    behaviour,
    account,
  });

  // 写于这个人还没有第二个账号时，不是对一个它从没见过的邮箱的同意。
  expect(ruleMatches(rule("allow"), send(HOME))).toBe(false);
  expect(ruleMatches(rule("pre_approved"), send(HOME))).toBe(false);
  // 员工主人的规则也一样（fork 的第三层）。
  expect(ruleMatches(rule("allow"), send(HOME), "owner_rule")).toBe(false);
  // 它照旧覆盖不点名账号的调用。
  expect(ruleMatches(rule("allow"), send())).toBe(true);
  // 严的规则对每个账号都成立。
  expect(ruleMatches(rule("ask"), send(HOME))).toBe(true);
  expect(ruleMatches(rule("hand_off"), send(HOME))).toBe(true);
  expect(ruleMatches(rule("deny"), send(HOME), "owner_rule")).toBe(true);
  // 团队规则是管理员对这个应用的策略，不论哪个账号。
  expect(ruleMatches(rule("allow"), send(HOME), "team_rule")).toBe(true);
  // 针对一个账号的规则只关乎那个账号，在任何一层。
  expect(ruleMatches(rule("ask", WORK), send(HOME), "team_rule")).toBe(false);
  expect(ruleMatches(rule("allow", WORK), send(WORK))).toBe(true);
  // 大小写与首尾空白不造成两个账号。
  expect(ruleMatches(rule("allow", " Dana@Work.Example "), send(WORK))).toBe(
    true,
  );
});

test("the strictest rule still wins across the layers, whichever account", () => {
  const ask = {
    id: randomUUID(),
    ownerUserId: owner,
    botId: "*",
    toolRef: "gmail/*",
    effect: "write",
    scope: "gmail",
    behaviour: "ask" as const,
    account: null,
    revokedAt: null,
    createdAt: new Date(),
  };
  const allowWork = {
    ...ask,
    id: randomUUID(),
    behaviour: "allow" as const,
    account: WORK,
  };
  expect(strictestRule(send(WORK), [], [allowWork, ask])?.rule.behaviour).toBe(
    "ask",
  );
});

test("the card names the account it is asking about", () => {
  const words = approvalWords({
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    scope: "gmail",
    account: WORK,
  });
  expect(words.place).toBe(`Gmail 账号 ${WORK}`);
  expect(
    approvalPhrase({
      toolRef: "gmail/GMAIL_SEND_EMAIL",
      scope: "gmail",
      account: WORK,
    }),
  ).toBe(`send email（Gmail 账号 ${WORK}）`);
  // 只有一个账号时没有什么要区分的，卡片读法不变。
  const single = approvalWords({
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    scope: "gmail",
  });
  expect(single.place).toBe("Gmail");
  expect(
    approvalPhrase({ toolRef: "gmail/GMAIL_SEND_EMAIL", scope: "gmail" }),
  ).toBe("send email（Gmail）");
});
