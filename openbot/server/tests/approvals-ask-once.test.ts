import { describe, expect, test } from "bun:test";
import {
  APPROVAL_GUIDANCE,
  APPROVAL_GUIDANCE_APPS,
  approvalGuidance,
  DESTRUCTIVE_TOOL_NOTE,
} from "@openbot/shared/bot-prompt";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import { safetyRequirement } from "../src/approvals/policy";
import type { ApprovalCandidate } from "../src/approvals/types";
import { builtInAgentConfiguration, standingRoleMessage } from "../src/copilot";

/**
 * One ask for one consequential action.
 *
 * The person was asked twice for one delete: once by the Bot, on its own approval card, and again by
 * OpenBot's safety policy, which asks whatever came before. The policy's card names the exact action,
 * so it is the one that stays, and a Bot OpenBot runs is told not to ask first. That is safe only for
 * as long as the policy really asks about every action the Bot is told it asks about, which is what
 * the second half pins.
 *
 * M3: the guidance is the fork's Chinese wording (`APPROVAL_GUIDANCE` in shared/bot-prompt.ts),
 * written for the fork's floors in approvals/policy.ts, whose `safetyRequirement` names a floor by
 * the fork's source (`destructive_tool`, `outbound_send`, `share_access`, `publish_post`) where
 * upstream names a category (`sending`). An app tool reaches the policy marked `subject.connector`,
 * as the plugin store puts it to the gate.
 */

const click = (name: string, role = "button"): ApprovalCandidate => ({
  actorId: "owner",
  botId: "assistant",
  toolRef: "computer_click",
  effect: "write",
  scope: "app.example",
  args: { ref: "e12" },
  target: {
    pageUrl: "https://app.example/inbox",
    element: { ref: "e12", role, name },
  },
});

// An app tool, as the plugin store puts it to the gate.
const app = (
  name: string,
  options: { destructive?: true; args?: Record<string, unknown> } = {},
): ApprovalCandidate => ({
  actorId: "owner",
  botId: "assistant",
  toolRef: `acme-crm/${name}`,
  effect: "write",
  scope: "acme-crm",
  args: options.args ?? { id: "51" },
  subject: { connector: true },
  ...(options.destructive ? { destructive: options.destructive } : {}),
});

const tool = (name: string): GrantedTool => ({
  name,
  ref: name,
  description: name,
  parameters: z.object({}),
  execute: async () => "unused",
});

const promptHolding = (tools: GrantedTool[] = []) => {
  const configuration = builtInAgentConfiguration(
    {
      id: "personal-assistant",
      name: "Personal Assistant",
      type: "built_in",
      systemPrompt: "Help with everyday errands.",
    },
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    "openai-secret",
    tools,
  );
  return "prompt" in configuration ? (configuration.prompt ?? "") : "";
};

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("a Bot OpenBot runs leaves the asking to OpenBot", () => {
  test("it is told OpenBot asks before consequential actions, and not to ask first", () => {
    expect(APPROVAL_GUIDANCE).toContain("所以你不要先问");
    // With a connected app's tool, the whole guidance, the app-tools bullet included.
    expect(promptHolding([tool("mcp__acme-crm__delete_contact")])).toContain(
      APPROVAL_GUIDANCE,
    );
    // With none, the guidance without that bullet: the same condition `CONNECTOR_APPROVAL_GUIDANCE` has.
    for (const tools of [[], [tool("recall_personal_memory")]]) {
      const prompt = promptHolding(tools);
      expect(prompt).toContain(approvalGuidance({ apps: false }));
      expect(prompt).not.toContain(APPROVAL_GUIDANCE_APPS);
    }
  });

  test("a remote Bot is not told so: its own tools don't go through OpenBot's gate", () => {
    const role = standingRoleMessage({
      id: "risk",
      name: "Risk",
      title: "Risk desk",
      roleDescription: "Investigate policies.",
    });
    expect(role.content).not.toContain(approvalGuidance({ apps: false }));
    expect(role.content).not.toContain(APPROVAL_GUIDANCE_APPS);
  });

  // Each button the guidance names, as a Bot presses it: the policy must ask about every one.
  test.each([
    ["删除", "Delete", "destructive_tool"],
    ["删除", "删除", "destructive_tool"],
    ["移除", "Remove", "destructive_tool"],
    ["移除", "移除", "destructive_tool"],
    ["发送", "Send", "outbound_send"],
    ["发送", "发送", "outbound_send"],
    ["回复", "Reply", "outbound_send"],
    ["回复", "回复", "outbound_send"],
    ["评论", "Comment", "outbound_send"],
    ["评论", "评论", "outbound_send"],
    ["分享", "Share", "share_access"],
    ["分享", "分享", "share_access"],
    ["邀请", "Invite", "share_access"],
    ["邀请", "邀请", "share_access"],
    ["发帖", "Post", "publish_post"],
    ["发布", "Publish", "publish_post"],
    ["发布", "发布", "publish_post"],
    ["转发", "转发", "publish_post"],
  ] as const)(
    "the guidance says OpenBot asks before you click %s (%s), and it does",
    (said, button, source) => {
      expect(APPROVAL_GUIDANCE).toContain(said);
      expect(safetyRequirement(click(button))).toMatchObject({
        id: source,
        behaviour: "ask",
      });
    },
  );

  test("pressing one of those buttons with Enter or Space asks as clicking it does", () => {
    expect(APPROVAL_GUIDANCE).toContain("也包括用 Enter 或空格按下它们");
    for (const key of ["Enter", "Space", " "])
      expect(
        safetyRequirement({
          ...click("Send"),
          toolRef: "computer_key",
          args: { ref: "e12", key },
        })?.behaviour,
      ).toBe("ask");
  });

  test("Enter or Space on the page with no element named asks", () => {
    expect(APPROVAL_GUIDANCE).toContain(
      "没有指明元素时在页面上按 Enter 或空格",
    );
    for (const key of ["Enter", "Space"])
      expect(
        safetyRequirement({
          actorId: "owner",
          botId: "assistant",
          toolRef: "computer_key",
          effect: "write",
          scope: "app.example",
          args: { key },
          target: { pageUrl: "https://app.example/inbox" },
        })?.behaviour,
      ).toBe("ask");
  });

  test("the buttons the guidance leaves to the Bot are not floors", () => {
    expect(APPROVAL_GUIDANCE).toContain(
      "其它按钮，例如 Submit、Save、Continue、提交、保存，不在此列",
    );
    for (const button of ["Submit", "Save", "Continue", "提交", "保存"])
      expect(safetyRequirement(click(button))).toBeUndefined();
  });

  test("paying and buying are handed to the person, as the guidance says", () => {
    const guidance = flat(APPROVAL_GUIDANCE);
    expect(guidance).toContain("付款、购买");
    expect(guidance).toContain("告诉对方需要他本人操作");
    for (const button of ["Pay", "Buy now", "Place your order", "立即购买"])
      expect(safetyRequirement(click(button))).toMatchObject({
        id: "payments",
        behaviour: "hand_off",
      });
  });

  test("a new password is handed to the person, as the guidance says", () => {
    expect(APPROVAL_GUIDANCE).toContain("修改密码");
    expect(
      safetyRequirement({
        actorId: "owner",
        botId: "assistant",
        toolRef: "computer_type",
        effect: "write",
        scope: "mail.example",
        args: { ref: "e3", text: "hunter2" },
        target: {
          pageUrl: "https://mail.example/settings",
          element: { ref: "e3", role: "textbox", name: "New password" },
        },
      }),
    ).toMatchObject({ id: "credentials", behaviour: "hand_off" });
  });

  test("the guidance promises a card for the person's apps, never on the Bot's own computer", () => {
    expect(APPROVAL_GUIDANCE_APPS).toContain(
      "已连接应用的工具（名字以 mcp__ 开头）",
    );
    expect(APPROVAL_GUIDANCE).toContain("你自己的电脑是你的草稿空间");
    expect(APPROVAL_GUIDANCE).toContain("记忆等 OpenBot 内部工具也不在此列");
    // As the policy has it: deleting a file in the Bot's own workspace is an ordinary change.
    expect(
      safetyRequirement({
        actorId: "owner",
        botId: "assistant",
        toolRef: "computer_run_command",
        effect: "write",
        scope: "workspace",
        args: { command: "rm -f decline-test-f6.txt && echo deleted" },
      }),
    ).toBeUndefined();
    expect(safetyRequirement(app("GOOGLEDRIVE_DELETE_FILE"))?.behaviour).toBe(
      "ask",
    );
  });

  test("the guidance says OpenBot asks before an app tool named to delete or archive, and it does", () => {
    expect(APPROVAL_GUIDANCE_APPS).toContain("名字表明会删除或归档的");
    for (const name of [
      "GOOGLEDRIVE_DELETE_FILE",
      "HUBSPOT_ARCHIVE_CONTACT",
      "remove_member",
    ])
      expect(safetyRequirement(app(name))).toMatchObject({
        id: "destructive_tool",
        behaviour: "ask",
      });
  });

  test("a tool its app marks destructive says so on itself, as the guidance names it, and OpenBot asks", () => {
    expect(APPROVAL_GUIDANCE_APPS).toContain(
      "应用标为破坏性的（会删除或覆盖内容）",
    );
    expect(DESTRUCTIVE_TOOL_NOTE).toContain("deletes or overwrites something");
    expect(DESTRUCTIVE_TOOL_NOTE).toContain("Don't ask them first.");
    // Named like nothing, so only the mark can tell the Bot.
    expect(safetyRequirement(app("reset_pipeline"))).toBeUndefined();
    expect(
      safetyRequirement(app("reset_pipeline", { destructive: true })),
    ).toMatchObject({ id: "destructive_tool", behaviour: "ask" });
  });

  /*
   * Which once-only floor answers is the fork's order (`onceOnlyFloor`): its own send floor reads a
   * name first, so a share or a post it already took for a send keeps that source. Either way the
   * call asks, and only once.
   */
  test.each([
    ["发送", "GMAIL_SEND_EMAIL"],
    ["回复", "GMAIL_REPLY_TO_THREAD"],
    ["转发", "GMAIL_FORWARD_MESSAGE"],
    ["通知", "notify_channel"],
    ["邀请", "invite_user"],
    ["评论", "create_comment"],
    ["分享", "GOOGLEDRIVE_SHARE_FILE"],
    ["修改访问权限", "update_file_permissions"],
    ["发帖", "LINKEDIN_CREATE_POST"],
    ["公开发布", "publish_release"],
  ] as const)(
    "the guidance says OpenBot asks before an app tool named to %s (%s), and it does",
    (said, name) => {
      expect(APPROVAL_GUIDANCE_APPS).toContain(said);
      const requirement = safetyRequirement(app(name));
      expect(requirement?.behaviour).toBe("ask");
      expect(["outbound_send", "share_access", "publish_post"]).toContain(
        requirement?.id ?? "",
      );
    },
  );

  test("the guidance says a call that names a recipient's or an invitee's address asks, and it does", () => {
    expect(APPROVAL_GUIDANCE_APPS).toContain(
      "参数里写明了收件人或受邀人邮箱的调用",
    );
    expect(
      safetyRequirement(
        app("create_event", {
          args: { summary: "Review", attendees: ["ana@example.com"] },
        }),
      ),
    ).toMatchObject({ id: "outbound_send", behaviour: "ask" });
    expect(
      safetyRequirement(
        app("create_ticket", { args: { to: "ops@example.com", title: "x" } }),
      ),
    ).toMatchObject({ id: "outbound_send", behaviour: "ask" });
  });
});

describe("a send by keyboard asks, as a Send button does", () => {
  const press = (key: string, field = "Message body"): ApprovalCandidate => ({
    actorId: "owner",
    botId: "assistant",
    toolRef: "computer_key",
    effect: "write",
    scope: "mail.google.com",
    args: { key, ref: "f3" },
    target: {
      pageUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
      element: { ref: "f3", role: "textbox", name: field },
    },
  });
  const submit = (field: string): ApprovalCandidate => ({
    actorId: "owner",
    botId: "assistant",
    toolRef: "computer_type",
    effect: "write",
    scope: "app.slack.com",
    args: { ref: "f9", text: "Friday works.", submit: true },
    target: {
      pageUrl: "https://app.slack.com/client/T1/C1",
      element: { ref: "f9", role: "textbox", name: field },
    },
  });

  test("the guidance names it", () => {
    expect(APPROVAL_GUIDANCE).toContain(
      "在写消息、回复或评论的输入框里按 Enter、Ctrl+Enter 或 Cmd+Enter",
    );
  });

  test.each([
    "Meta+Enter",
    "Control+Enter",
    "ControlOrMeta+Enter",
    "Ctrl+Enter",
  ])("%s sends", (key) => {
    expect(safetyRequirement(press(key))).toMatchObject({
      id: "outbound_send",
      behaviour: "ask",
    });
  });

  test("Enter in a box for writing a message sends", () => {
    expect(safetyRequirement(press("Enter", "Message #general"))?.id).toBe(
      "outbound_send",
    );
    expect(safetyRequirement(submit("Message #general"))?.id).toBe(
      "outbound_send",
    );
    expect(safetyRequirement(submit("Reply…"))?.id).toBe("outbound_send");
    expect(safetyRequirement(submit("写评论"))?.id).toBe("outbound_send");
  });

  test("Enter in a search box, a plain field or a letter does not", () => {
    expect(safetyRequirement(submit("Search messages"))).toBeUndefined();
    expect(safetyRequirement(submit("Subject"))).toBeUndefined();
    expect(safetyRequirement(press("Enter", "Subject"))).toBeUndefined();
    expect(safetyRequirement(press("Shift+Enter"))).toBeUndefined();
    expect(safetyRequirement(press("a"))).toBeUndefined();
    expect(safetyRequirement(press("Control+a"))).toBeUndefined();
  });
});
