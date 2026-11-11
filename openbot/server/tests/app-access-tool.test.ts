import { describe, expect, test } from "bun:test";
import {
  readConnectPrompt,
  SHOW_APP_ACCESS_TOOL,
} from "../../shared/connect-prompt";
import { setEdition } from "../src/edition";
import type { AppAccess, AppAccessState } from "../src/plugins/app-access";
import type { AppInspection } from "../src/plugins/app-access-store";
import {
  SHOW_APP_ACCESS_REF,
  showAppAccessTools,
} from "../src/plugins/show-app-access-tool";
import { REFUSAL_MARKER } from "../src/plugins/tools";

/**
 * 每位员工都持有的 `show_app_access`（上游 `app-access-tool.test.ts`，按 fork 接口改写，X2）。
 *
 * 这个工具只读：问 store 这个应用对这个人、这位员工是什么，回答带卡片的标记（应用、员工、`reason: "access"`）
 * 和一句给模型的话。它从不建申请——按卡片才建，那是人在按。
 *
 * 上游这个文件的后半段（拒绝里的卡片署上员工 `addressedTo`）测的是 `plugins/tools.ts`，那是 M5 留给 X 系列的
 * 位置，等 M5 合入后再带过来。
 */

function access(state: AppAccessState): AppAccess {
  return {
    key: "composio-gmail",
    displayName: "Gmail",
    logo: null,
    provider: "composio",
    account: "personal",
    connect: "consent",
    authScheme: "OAUTH2",
    accountMode: "personal",
    state,
    unavailable: state === "disabled" ? "absent" : null,
    accountHolder: "you",
    asksFirst: false,
    granted:
      state !== "not_granted" &&
      state !== "disabled" &&
      state !== "owner_grantable",
    ownerGrants: "any",
    givenByOwner: false,
    needsConnect: false,
    connectedAt: null,
    requestKind: null,
    request: null,
  };
}

function toolOver(answer: AppAccess | null) {
  const asked: unknown[] = [];
  const [tool] = showAppAccessTools({
    store: {
      inspectApp: async (input) => {
        asked.push(input);
        return answer ? ({ access: answer } as unknown as AppInspection) : null;
      },
    },
    botId: "expenses",
    actorId: "usr_7",
    composioConfigured: true,
  });
  if (!tool) throw new Error("no tool");
  return { tool, asked };
}

describe("show_app_access", () => {
  test("is offered under its shared name and its own ref", () => {
    const { tool } = toolOver(null);
    expect(tool.name).toBe(SHOW_APP_ACCESS_TOOL);
    expect(tool.ref).toBe(SHOW_APP_ACCESS_REF);
    expect(tool.description).toContain("instead of only saying it is missing");
  });

  test("asks about the app for this person on this Bot", async () => {
    const { tool, asked } = toolOver(access("disabled"));
    await tool.execute({ app: "Gmail" });
    expect(asked).toEqual([
      {
        app: "Gmail",
        agentId: "expenses",
        userId: "usr_7",
        composioConfigured: true,
      },
    ]);
  });

  test.each([
    ["ready", /已经可以通过你使用/],
    ["not_connected", /卡片上有「连接」/],
    ["reconnect", /卡片上有「重新连接」/],
    ["shared_not_connected", /要等管理员连接/],
    ["shared_not_approved", /管理员还没有批准你使用它/],
    ["disabled", /还没有打开.*申请打开/],
    ["not_granted", /没有授予你.*申请授予/],
    ["owner_grantable", /可以自己给你/],
  ] as const)(
    "answers %s with the card marker and the state in words",
    async (state, said) => {
      const { tool } = toolOver(access(state));
      const answer = await tool.execute({ app: "gmail" });
      // 不是拒绝：对话记录读这个工具的普通回答来画卡片。
      expect(answer.startsWith(REFUSAL_MARKER)).toBe(false);
      const prompt = readConnectPrompt(answer);
      expect(prompt).toMatchObject({
        serverId: "composio-gmail",
        title: "Gmail",
        agentId: "expenses",
        reason: "access",
        blocked: state !== "ready",
      });
      expect(prompt?.message).toMatch(said);
      expect(prompt?.message).toContain("不要改用浏览器去打开它的网站");
    },
  );

  test("a teammate's own account on somebody else's Team Bot is said to ask first", async () => {
    const { tool } = toolOver({ ...access("ready"), asksFirst: true });
    const message =
      readConnectPrompt(await tool.execute({ app: "gmail" }))?.message ?? "";
    expect(message).toContain("第一次调用会先问");
  });

  test.each(["disabled", "not_granted"] as const)(
    "in the personal edition, %s tells the model the card connects it, not to ask an administrator",
    async (state) => {
      setEdition("personal");
      try {
        const { tool } = toolOver(access(state));
        const message =
          readConnectPrompt(await tool.execute({ app: "gmail" }))?.message ??
          "";
        expect(message).toMatch(/卡片上有「连接」/);
        expect(message).not.toMatch(/管理员/);
      } finally {
        setEdition("team");
      }
    },
  );

  test.each([
    {
      card: "打开，然后连接（刚装好的 Gmail）",
      access: { state: "disabled", connect: null, authScheme: null },
      says: /卡片上有「打开」；如果卡片接着出现「连接」/,
    },
    {
      card: "连接（要登录的应用）",
      access: { state: "disabled", connect: "consent" },
      says: /一按就打开并连接它/,
    },
    {
      card: "设置（要填密钥的应用）",
      access: { state: "not_granted", connect: "key" },
      says: /打开填写密钥的页面/,
    },
    {
      card: "去设置（还没有 broker 的 key）",
      access: {
        state: "disabled",
        connect: null,
        unavailable: "composio_unconfigured",
      },
      says: /还没有设置好.*「去设置」/,
    },
  ] as const)(
    "in the personal edition, the model is told the card's own button: $card",
    async ({ access: overrides, says }) => {
      setEdition("personal");
      try {
        const { tool } = toolOver({
          ...access(overrides.state),
          ...overrides,
        } as AppAccess);
        const message =
          readConnectPrompt(await tool.execute({ app: "gmail" }))?.message ??
          "";
        expect(message).toMatch(says);
        expect(message).not.toMatch(/管理员/);
      } finally {
        setEdition("team");
      }
    },
  );

  test("an app nobody can name gets a plain sentence and no card", async () => {
    const { tool } = toolOver(null);
    const answer = await tool.execute({ app: "Frobnicator" });
    expect(readConnectPrompt(answer)).toBeNull();
    expect(answer).toContain("没有叫「Frobnicator」的应用");
  });

  test("arguments that name no app are refused before the store is asked", async () => {
    const { tool, asked } = toolOver(access("ready"));
    expect(await tool.execute({})).toBe("请写明要查看的应用。");
    expect(await tool.execute({ app: "   " })).toBe("请写明要查看的应用。");
    expect(asked).toEqual([]);
  });
});
