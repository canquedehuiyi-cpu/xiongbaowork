import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { decideAction } from "../src/approvals/policy";
import type { ApprovalCandidate, ApprovalRule } from "../src/approvals/types";
import { builtInAgentConfiguration } from "../src/copilot";
import { type GrantedTool, grantedToolGuidance } from "../src/plugins/tools";
import {
  computerGuidanceForRun,
  proactiveInitiator,
} from "../src/proactive/restriction";
import { loadTenantPackage } from "../src/tenant-package";
import { UNTRUSTED_GUIDANCE } from "../src/untrusted-content";

/**
 * 默认的中文网页搜索：员工用自己的浏览器搜百度，百度不行再搜必应（2026-11-09 用户选定的免费方案）。
 *
 * 不接任何付费搜索服务。Parallel 是境外服务，在国内可能慢或连不上，所以中文问题先走浏览器搜百度；
 * 员工同时持有 Parallel 时，英文和国际信息仍可以用它。没有浏览器的员工，引导一个字都不变。
 */
const BAIDU = "https://www.baidu.com/s?wd=";
const BING = "https://cn.bing.com/search?q=";

const tool = (server: string, name: string): GrantedTool => ({
  name: `mcp__${server}__${name}`,
  ref: `${server}/${name}`,
  description: "unused",
  parameters: z.object({}),
  execute: async () => "unused",
});
const parallel = [
  tool("parallel", "web_search"),
  tool("parallel", "web_fetch"),
];
const drive = [tool("google-drive", "search_files")];
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("员工持有浏览器时的公开网页搜索引导", () => {
  test("没有 Parallel：给出百度搜索地址和必应备选地址，并说清怎么读、怎么引用", () => {
    const guidance = grantedToolGuidance([], [], { browser: true });

    expect(guidance).toContain(BAIDU);
    expect(guidance).toContain(BING);
    expect(guidance.indexOf(BAIDU)).toBeLessThan(guidance.indexOf(BING));
    expect(guidance).toContain("computer_navigate");
    expect(guidance).toContain("computer_read");
    const text = flat(guidance).toLowerCase();
    // 关键词要 URL 编码；读结果页，再打开 1–3 个来源页核对；回答给来源链接和查询日期。
    expect(text).toContain("url-encode");
    expect(text).toContain("one to three");
    expect(text).toContain("source links");
    expect(text).toContain("date you searched");
    // 中文问题优先百度。
    expect(text).toContain("questions in chinese");
    // 没有 Parallel 就不提 Parallel。
    expect(guidance).not.toContain("Parallel");
  });

  test("遇到验证码、登录墙如实说明，不绕过，也不让对方去登录", () => {
    const text = flat(
      grantedToolGuidance([], [], { browser: true }),
    ).toLowerCase();
    expect(text).toContain("captcha");
    expect(text).toContain("sign-in wall");
    expect(text).toContain("do not try to get around it");
    expect(text).toContain("do not ask the person to sign in");
    expect(text).toContain("tell the person plainly");
  });

  test("只搜公开信息，不把对话全文或私人文件内容当关键词", () => {
    const text = flat(
      grantedToolGuidance([], [], { browser: true }),
    ).toLowerCase();
    expect(text).toContain("public information only");
    expect(text).toContain("never the conversation");
    expect(text).toContain("private document");
  });

  test("持有 Parallel：两段引导都在，中文问题先走百度，Parallel 留给英文和国际信息", () => {
    const guidance = grantedToolGuidance(parallel, [], { browser: true });
    const text = flat(guidance);

    // 原有的 Parallel 引导一句不少。
    expect(guidance).toContain(
      "Parallel provides public-web search and extraction: mcp__parallel__web_search and mcp__parallel__web_fetch discover sources and read selected pages.",
    );
    expect(guidance).toContain(
      "Send only the research objective, necessary search queries and requested URLs, not a full transcript or private documents.",
    );
    expect(guidance).toContain(
      "Cite source URLs and distinguish excerpts from full-page reads.",
    );
    // 浏览器搜索也在。
    expect(guidance).toContain(BAIDU);
    expect(guidance).toContain(BING);
    // 两段说的是同一件事：中文问题先百度，Parallel 用于英文和国际信息。
    expect(text).toContain(
      "For a question in Chinese, search Baidu in your browser first",
    );
    expect(text).toContain(
      "use Parallel for English-language or international information",
    );
    // Parallel 的段落不能再写成浏览器只用于交互：那会和「中文先百度」打架。
    expect(guidance).not.toContain(
      "Interactive browser work still uses the authorized computer tools when needed.",
    );
  });

  test("不削弱已连接系统的规则：只适用于公开网页，原有的不许浏览、缺授权如实说、审批门都还在", () => {
    const guidance = grantedToolGuidance(drive, ["google-drive", "gmail"], {
      browser: true,
    });
    const text = flat(guidance);
    for (const rule of [
      "Do NOT browse to one of their websites instead",
      "that is a missing grant and not something to work around",
      "Do not reach for the browser, do not ask the person to sign in",
      "OpenBot itself asks the person before you delete or archive anything",
      "This deployment also connects to: gmail. You hold none of their tools.",
      "Do NOT browse to its website",
    ])
      expect(text).toContain(rule);
    // 新段落自己说清楚：只用于公开网页，不是进入已连接系统的路。
    expect(text).toContain("This is for public web pages only");
    expect(text).toContain(
      "never a way into a system this deployment connects to",
    );
    // 已连接系统的明确禁令放在最后，不被新段落盖住。
    expect(guidance.indexOf(BAIDU)).toBeLessThan(
      guidance.indexOf("This deployment also connects to"),
    );
  });
});

describe("员工没有浏览器时，引导与原来逐字一致", () => {
  // 改动前由当前代码生成的原文。
  const BEFORE =
    "You can reach these systems directly, as the person asking, with their own access:\n- google-drive: search_files\n- parallel: web_search, web_fetch\nUse them for anything about those systems. Do NOT browse to one of their websites instead: your\nbrowser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall\nthat connecting an account has already solved.\nIf one of these systems is involved and no tool above covers the part you need, that is a\nmissing grant and not something to work around. Say so plainly, name the capability you would\nneed, and say an administrator can grant it on that connector. Do not reach for the browser, do\nnot ask the person to sign in, and do not ask them to fetch it for you: they already have the\naccess, and the thing that is missing is yours, not theirs.\nFor the tools of connected apps (their names start with mcp__), OpenBot itself asks the person before you delete or archive anything and before you use a tool marked destructive, on a card that shows exactly what you are about to do. So for those, do not ask them first: say what you are going to do and call the tool, and they are asked once, by OpenBot. This covers connected-app tools only: not your memory tools, and not commands or files on a computer.\nParallel provides public-web search and extraction: mcp__parallel__web_search and mcp__parallel__web_fetch discover sources and read selected pages.\nParallel searches the public web; it does not connect a person's private account. Send only the research objective, necessary search queries and requested URLs, not a full transcript or private documents. Generate one session_id for the conversation and reuse it on related search/fetch calls. Omit model_name unless the exact configured model identifier is known.\nCite source URLs and distinguish excerpts from full-page reads. Report provider errors or missing sources; do not invent evidence or quietly bypass a denial. Interactive browser work still uses the authorized computer tools when needed.\n\nThis deployment also connects to: gmail. You hold none of their tools.\nIf a question needs one of them, say plainly that you have not been granted it and that an\nadministrator can grant it on that connector. Do NOT browse to its website: that is not the\nsame thing, your browser is signed in as nobody, and it will meet a sign-in wall that the\nconnector exists to avoid. Do not ask the person to sign in there either.";
  const tools = [...drive, ...parallel];
  const vendors = ["google-drive", "gmail"];

  test("快照：不传、传空选项、显式 browser: false，三种写法都与原文一致", () => {
    expect(grantedToolGuidance(tools, vendors)).toBe(BEFORE);
    expect(grantedToolGuidance(tools, vendors, {})).toBe(BEFORE);
    expect(grantedToolGuidance(tools, vendors, { browser: false })).toBe(
      BEFORE,
    );
  });

  test("什么都不持有时仍然什么都不说", () => {
    expect(grantedToolGuidance([])).toBe("");
    expect(grantedToolGuidance([], [], { browser: false })).toBe("");
  });

  test("任何不带浏览器的组合都不出现搜索地址", () => {
    for (const [held, missing] of [
      [[], ["gmail"]],
      [drive, []],
      [parallel, []],
      [[...drive, ...parallel], ["gmail"]],
    ] as const) {
      const guidance = grantedToolGuidance([...held], [...missing]);
      expect(guidance).not.toContain(BAIDU);
      expect(guidance).not.toContain(BING);
    }
  });
});

describe("内置员工的提示词", () => {
  const agent = {
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in" as const,
    systemPrompt: "Be helpful.",
  };
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };

  test("部署有电脑：搜索引导在，且排在电脑说明之前", () => {
    const prompt = builtInAgentConfiguration(
      agent,
      model,
      "synthetic-key",
      [],
      "COMPUTER GUIDANCE HERE",
    ).prompt as string;
    expect(prompt).toContain(BAIDU);
    expect(prompt.indexOf(BAIDU)).toBeLessThan(
      prompt.indexOf("COMPUTER GUIDANCE HERE"),
    );
  });

  test("部署没有电脑：提示词与原来逐字一致", () => {
    const prompt = builtInAgentConfiguration(agent, model, "synthetic-key")
      .prompt as string;
    expect(prompt).toBe(
      `Be helpful.\n\n${PROVENANCE_GUIDANCE}\n\n${UNTRUSTED_GUIDANCE}`,
    );
  });
});

describe("后台只读调研没有浏览器，也不被告知有", () => {
  test("后台调研的运行拿不到电脑说明，其他运行照旧", () => {
    expect(
      computerGuidanceForRun(proactiveInitiator("run-1"), "COMPUTER"),
    ).toBeUndefined();
    expect(computerGuidanceForRun({ kind: "person" }, "COMPUTER")).toBe(
      "COMPUTER",
    );
    expect(
      computerGuidanceForRun({ kind: "routine", id: "routine-1" }, "COMPUTER"),
    ).toBe("COMPUTER");
    expect(computerGuidanceForRun(undefined, "COMPUTER")).toBe("COMPUTER");
    expect(
      computerGuidanceForRun({ kind: "person" }, undefined),
    ).toBeUndefined();
  });
});

describe("技能 web-search-guide", () => {
  test("写明用浏览器搜百度、必应作备选，tools 仍为空", async () => {
    const loaded = await loadTenantPackage("../examples/qoderwake");
    const skill = loaded.skills.find(
      (entry) => entry.slug === "web-search-guide",
    );
    expect(skill).toBeDefined();
    const instructions = skill?.instructions ?? "";
    expect(instructions).toContain(BAIDU);
    expect(instructions).toContain(BING);
    expect(instructions.indexOf(BAIDU)).toBeLessThan(
      instructions.indexOf(BING),
    );
    expect(instructions).toContain("浏览器");
    expect(instructions).toContain("来源");
    // 电脑工具是内置工具，不是 serverId/toolName，填进 tools 加载会报错。
    expect(skill?.tools).toEqual([]);
  });

  test("去掉了「待 MCP 实测拿到工具名后补 tools」这条过时注释", () => {
    const yaml = readFileSync(
      new URL("../../examples/qoderwake/skills.yaml", import.meta.url),
      "utf8",
    );
    const lines = yaml.split("\n");
    const at = lines.findIndex((line) =>
      line.includes("slug: web-search-guide"),
    );
    expect(at).toBeGreaterThan(0);
    // 紧挨着这条技能的上方注释不再是「待补 tools」。
    const above = lines.slice(Math.max(0, at - 4), at).join("\n");
    expect(above).not.toContain("待 MCP 实测拿到工具名后补 tools");
  });
});

/**
 * 审批核对（只核对，不改策略）：打开百度搜索页是一次「读」，默认不弹审批卡片。
 *
 * 网关把 `computer_navigate` 记成 effect `read`、scope 为目标主机（computer/gateway.ts 的 `govern`），
 * 读不经自动审查、不受「改动前先问」默认项约束，命令和路径底线也不管它。设备模式下 `subject.runner`
 * 为真，主机命令上限只管命令和本机应用，同样不管它。主人在员工权限页把「打开网页」设成「询问」时，
 * 每次都会问；设成「禁用」时直接拒绝。
 */
describe("打开百度搜索页的审批核对", () => {
  const candidate = (runner: boolean): ApprovalCandidate => {
    const url = `${BAIDU}%E4%B8%8A%E6%B5%B7%20%E5%A4%A9%E6%B0%94`;
    return {
      actorId: "person-1",
      botId: "bot-1",
      toolRef: "computer_navigate",
      effect: "read",
      scope: "www.baidu.com",
      args: { targetUrl: url },
      target: { pageUrl: url },
      subject: { runner },
    };
  };
  const decide = (runner: boolean, personal: ApprovalRule[] = []) =>
    decideAction({
      candidate: candidate(runner),
      team: [],
      personal,
      customRulesEnabled: true,
      // 最严的个人偏好：改动前先问、自动审查都开着。
      autoReview: true,
      askBeforeChanges: true,
      enforceDangerousCommands: true,
      hostCommandsCap: "ask",
    });
  const rule = (behaviour: ApprovalRule["behaviour"]): ApprovalRule => ({
    id: "rule-1",
    ownerUserId: "person-1",
    botId: "bot-1",
    toolRef: "computer_navigate",
    effect: "*",
    scope: "*",
    behaviour,
    revokedAt: null,
    createdAt: new Date(),
  });

  test("云端模式和设备模式默认都直接放行，不弹卡片", async () => {
    for (const runner of [false, true]) {
      const outcome = await decide(runner);
      expect(outcome.behaviour).toBe("allow");
      expect(outcome.source).toBe("default");
    }
  });

  test("主人把「打开网页」设成询问：每次都问；设成禁用：直接拒绝", async () => {
    expect((await decide(true, [rule("ask")])).behaviour).toBe("ask");
    expect((await decide(true, [rule("deny")])).behaviour).toBe("deny");
  });
});
