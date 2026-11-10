import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray } from "drizzle-orm";
import {
  saveTeamActionKinds,
  saveTeamReviewerGuidance,
  teamSettingsColumns,
} from "../src/approvals/extra-columns";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  withApprovalContext,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import {
  approvalRequests,
  approvalTeamRules,
  approvalTeamSettings,
} from "../src/db/schema/approvals";
import { auditEvents, channels, users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { setEdition } from "../src/edition";
import { runAsTenant } from "../src/tenant/context";
import { setRole } from "../src/auth/roles";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll, beforeAll, test } from "./support/platform-frame";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 熊宝的审批底线，经真实的闸门、策略和存储：上游 #1394 的同样场景，断言相反。
 *
 * M5: 为什么和上游不同。上游这份测试叫「默认打开」（OPEN BY DEFAULT）：发送、删除、分享、发帖、付款
 * 先问，但本人可以答「允许一次」「在这段对话里都允许」或「在这里总是允许」，管理员可以替所有人关上某一种。
 * 它推翻了 #998 只给「允许一次 / 拒绝」的做法。用户定了保留熊宝的底线、不收「默认打开」：
 * - 删除、对外发送、分享、发帖只能「允许一次」：卡片不提供长期允许，「在这段对话里都允许」「总是允许」
 *   的回答被拒绝，存下的允许和团队的允许规则都打不开它，同一段对话里下一次照样先问；
 * - 付款、改凭据、改安全设置交给本人（`hand_off`），连「允许一次」都没有。
 * 管理员仍然可以把一种动作设得更严（每次都问、交给本人）；设回「打开」也只是回到底线。
 * 文件名沿用上游，便于对照。
 *
 * M5: fork 是多租户的：钩子和用例在平台帧里跑（tests/support/platform-frame），每个人的闸门、回答和收件箱
 * 在本人的帧里，和真正的运行一样；管理员的角色经受限的角色写入者写入，团队设置和团队规则才认得他。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `open-${randomUUID()}`;
const people: string[] = [];
const channelIds: string[] = [];
const teamRuleIds: string[] = [];
const admin = `${prefix}-admin`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
let priorTeam: Awaited<ReturnType<typeof readTeamRow>>[number] | undefined;
const readTeamRow = () =>
  database
    .select(teamSettingsColumns)
    .from(approvalTeamSettings)
    .where(eq(approvalTeamSettings.id, "team"));

async function person() {
  const id = `${prefix}-${people.length}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}

/** A connector call, as `plugins/plugin-store/calls.ts` puts it to the gate. */
const tool = (
  server: string,
  name: string,
  args: Record<string, unknown>,
  botId = `${prefix}-bot`,
): Omit<ApprovalCandidate, "actorId"> => ({
  botId,
  toolRef: `${server}/${name}`,
  effect: "write",
  scope: server,
  args,
  target: {
    serverId: server,
    toolName: name,
    url: `composio://${server}`,
    effect: "write",
  },
  // M5: as fork's `callTool` marks an app's tool call (the floors read app tools by where they came from).
  subject: { connector: true },
});

const slackSend = (text: string, botId?: string) =>
  tool(
    "composio-slack",
    "SLACK_SEND_MESSAGE",
    { channel: "C0PROJECT", text },
    botId,
  );

/** Runs the gate in `threadId`: undefined if it ran, the waiting request if it asked. */
async function gate(
  actorId: string,
  threadId: string,
  action: Omit<ApprovalCandidate, "actorId">,
) {
  const toolCallId = randomUUID();
  const outcome = await withApprovalContext(
    {
      runId: randomUUID(),
      threadId,
      toolCallId,
      toolName: action.toolRef,
      args: action.args as Record<string, unknown>,
      messages: [{ id: "u1", role: "user", content: "Keep the team posted." }],
      state: {},
      context: [],
      forwardedProps: {},
    },
    () => runAsTenant(actorId, () => service.gate({ ...action, actorId })),
  ).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      return error;
    },
  );
  if (!outcome) return undefined;
  const [request] = (
    await runAsTenant(actorId, () => store.list(actorId))
  ).filter((row) => row.action.toolCallId === toolCallId);
  if (!request) throw new Error("The gate suspended without a request.");
  return request;
}

/** The gate's verdicts on this person's actions, newest last. */
async function verdicts(owner: string) {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        eq(auditEvents.eventType, "approval.evaluated"),
      ),
    )
    .orderBy(auditEvents.createdAt);
  return rows.map(
    (row) =>
      (row.payload as { outcome: Record<string, unknown> }).outcome as {
        behaviour: string;
        source: string;
        kind?: string;
        reason: string;
      },
  );
}

const thread = () => `${prefix}-thread-${randomUUID()}`;
/** What a person's own request does, in their own frame. */
const as = <T>(id: string, work: () => T): T => runAsTenant(id, work);
let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  setEdition("team");
  await database.insert(users).values({ id: admin, email: `${admin}@x.test` });
  releaseRoleWriter = await bindTestRoleWriter(database);
  await setRole(database, admin, "admin");
  [priorTeam] = await readTeamRow();
});

afterAll(async () => {
  if (teamRuleIds.length)
    await database
      .delete(approvalTeamRules)
      .where(inArray(approvalTeamRules.id, teamRuleIds));
  await database
    .delete(approvalTeamSettings)
    .where(eq(approvalTeamSettings.id, "team"));
  // `actionKinds`、`reviewerGuidance` 不在冻结的 db/schema/approvals.ts 里，另写回去
  // （approvals/extra-columns.ts）。
  if (priorTeam) {
    const { actionKinds, reviewerGuidance, ...columns } = priorTeam;
    await database.insert(approvalTeamSettings).values(columns);
    await saveTeamActionKinds(database, actionKinds);
    await saveTeamReviewerGuidance(database, reviewerGuidance);
  }
  if (people.length) {
    const decided = await database
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, people));
    if (decided.length)
      await database.delete(workItems).where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(
            workItems.key,
            decided.map((request) => request.id),
          ),
        ),
      );
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, people));
  }
  if (channelIds.length)
    await database.delete(channels).where(inArray(channels.id, channelIds));
  await database.delete(users).where(inArray(users.id, [...people, admin]));
  await releaseRoleWriter?.();
  await database.$client.close();
});

/** What the server answers when somebody presses a standing answer on a send anyway. */
const SEND_ONCE_ONLY =
  "这个操作可能会把内容发给别人，每次都要你确认，只能「允许一次」或拒绝。";
const HANDED_TO_YOU =
  "This action is handed to you. Do it yourself and mark it done, or decline it.";

/** The floor on a send: it asks, and offers Allow once and Deny only. */
const SEND_FLOOR = { behaviour: "ask", source: "outbound_send" } as const;

describe("发送只能允许一次（上游：Allow for this conversation）", () => {
  test("a send asks, offers no standing answer, and refuses Allow for this conversation", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    expect(first?.action.policy).toMatchObject(SEND_FLOOR);
    expect(offersStandingRule(first?.action ?? {})).toBeFalse();
    await expect(
      as(owner, () =>
        service.decide(owner, first?.id ?? "", "allow_conversation"),
      ),
    ).rejects.toThrow(SEND_ONCE_ONLY);
    expect(
      (
        await as(owner, () =>
          service.decide(owner, first?.id ?? "", "allow_once"),
        )
      ).status,
    ).toBe("approved");

    // The next send in the same conversation asks again: nothing was granted for the conversation.
    expect(await gate(owner, here, slackSend("Review at 3."))).toMatchObject({
      status: "pending",
    });
    expect(
      (await verdicts(owner)).filter(
        (outcome) => outcome.source === "conversation",
      ),
    ).toEqual([]);
    expect(
      (await as(owner, () => service.inbox(owner))).conversationGrants,
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(approvalConversationGrants)
        .where(eq(approvalConversationGrants.ownerUserId, owner)),
    ).toEqual([]);
  });

  test("a delete asks the same way, in the same conversation and with another Bot", async () => {
    const owner = await person();
    const here = thread();
    const deleting = await gate(
      owner,
      here,
      tool("composio-slack", "SLACK_DELETE_A_MESSAGE", {
        channel: "C0PROJECT",
        ts: "1.2",
      }),
    );
    expect(deleting?.action.policy).toMatchObject({ behaviour: "ask" });
    expect(offersStandingRule(deleting?.action ?? {})).toBeFalse();
    expect(
      await gate(
        owner,
        here,
        slackSend("From another Bot.", `${prefix}-other`),
      ),
    ).toMatchObject({ status: "pending", action: { policy: SEND_FLOOR } });
  });
});

describe("发送不能「总是允许」（上游：Always allow here, on a send）", () => {
  test("Always allow is refused, nothing is saved, and the next send asks", async () => {
    const owner = await person();
    const first = await gate(owner, thread(), slackSend("Draft is up."));
    await expect(
      as(owner, () => service.decide(owner, first?.id ?? "", "allow_always")),
    ).rejects.toThrow(SEND_ONCE_ONLY);
    expect(await as(owner, () => store.rules(owner))).toEqual([]);
    expect(await gate(owner, thread(), slackSend("Merged."))).toMatchObject({
      status: "pending",
      action: { policy: SEND_FLOOR },
    });
  });

  test("an allow written about something else doesn't reach a send", async () => {
    const owner = await person();
    await as(owner, () =>
      service.createRule(owner, {
        botId: "*",
        toolRef: "composio-slack/*",
        effect: "*",
        scope: "*",
        behaviour: "allow",
      }),
    );
    // The rule still allows an ordinary Slack change...
    expect(
      await gate(
        owner,
        thread(),
        tool("composio-slack", "SLACK_ADD_REACTION_TO_AN_ITEM", {
          name: "eyes",
        }),
      ),
    ).toBeUndefined();
    // ...and a send still asks, as it did before it.
    expect(await gate(owner, thread(), slackSend("Hi."))).toMatchObject({
      status: "pending",
      action: { policy: SEND_FLOOR },
    });
  });
});

describe("管理员只能把一种动作设得更严（上游：an admin closes a kind）", () => {
  test("ask every time is marked on the floor, hand off goes to the person, and open is the floor again", async () => {
    const owner = await person();
    const here = thread();

    await service.setTeamSettings(admin, { actionKinds: { sending: "ask" } });
    const closed = await gate(owner, here, slackSend("Closed."));
    expect(closed?.action.policy).toMatchObject({
      ...SEND_FLOOR,
      closed: true,
    });
    expect(offersStandingRule(closed?.action ?? {})).toBeFalse();
    expect(
      (
        await as(owner, () =>
          service.decide(owner, closed?.id ?? "", "allow_once"),
        )
      ).status,
    ).toBe("approved");

    await service.setTeamSettings(admin, {
      actionKinds: { sending: "hand_off" },
    });
    expect(
      (await gate(owner, here, slackSend("Yours.")))?.action.policy,
    ).toMatchObject({ behaviour: "hand_off", kind: "sending" });

    // Open again is not open by default: the send is back at the floor, and still asks.
    await service.setTeamSettings(admin, { actionKinds: { sending: "open" } });
    expect(await gate(owner, here, slackSend("Open again."))).toMatchObject({
      status: "pending",
      action: { policy: SEND_FLOOR },
    });
  });

  test("a team rule that allows sends doesn't open the floor", async () => {
    const owner = await person();
    const rule = await service.createTeamRule(admin, {
      botId: "*",
      toolRef: "composio-slack/SLACK_SEND_MESSAGE",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    });
    teamRuleIds.push(rule.id);
    try {
      expect(await gate(owner, thread(), slackSend("Allowed?"))).toMatchObject({
        status: "pending",
        action: { policy: SEND_FLOOR },
      });
    } finally {
      await service.revokeTeamRule(admin, rule.id);
    }
  });
});

test("payments and a password typed on a website are the person's, with no answer to give", async () => {
  const owner = await person();
  const paying = await gate(
    owner,
    thread(),
    tool("composio-stripe", "STRIPE_PAY_INVOICE", { invoice: "in_1" }),
  );
  expect(paying?.action.policy).toMatchObject({
    behaviour: "hand_off",
    kind: "payments",
  });
  expect(offersStandingRule(paying?.action ?? {})).toBeFalse();

  const typed = await gate(owner, thread(), {
    botId: `${prefix}-bot`,
    toolRef: "computer_type",
    effect: "write",
    scope: "accounts.example.com",
    args: { ref: "e3", text: "hunter2" },
    target: {
      pageUrl: "https://accounts.example.com/change",
      element: { ref: "e3", role: "textbox", name: "New password" },
    },
  });
  expect(typed?.action.policy).toMatchObject({
    behaviour: "hand_off",
    kind: "credentials",
  });
  expect(offersStandingRule(typed?.action ?? {})).toBeFalse();
  for (const id of [paying?.id, typed?.id])
    await expect(
      as(owner, () => service.decide(owner, id ?? "", "allow_conversation")),
    ).rejects.toThrow(HANDED_TO_YOU);
  expect(
    await database
      .select()
      .from(approvalConversationGrants)
      .where(eq(approvalConversationGrants.ownerUserId, owner)),
  ).toEqual([]);
});
