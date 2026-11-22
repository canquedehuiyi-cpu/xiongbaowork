import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { APPROVAL_GUIDANCE_WEB_AND_HANDED_OVER } from "../../shared/bot-prompt";
import { READ_SKILL_TOOL, SKILL_FIELD_LIMITS } from "../../shared/self-skills";
import {
  browserRulesDeferred,
  deferredCategories,
  isBrowserTool,
  isDeploymentTool,
  slimModelTools,
} from "../src/agents/prompt-slim";
import {
  slimAskingGuidance,
  slimBrowserGuidance,
  slimComputerGuidance,
  slimDeliveryGuidance,
  slimWebResearchGuidance,
} from "../src/agents/slim-guidance";
import { searchToolsTool } from "../src/agents/tool-search";
import {
  builtInSkillGuidanceFor,
  FAST_PATH_ADVICE,
  fastPathSection,
  MATCHED_FAST_PATH_CHARS,
  matchedSkillChecks,
  OWN_SKILL_LINE_CHARS,
  OWN_SKILL_LIST_MAX,
  ownSkillsGuidance,
  type PickableSkill,
  readSkillText,
} from "../src/plugins/picked-skill";
import { renderSkill } from "../src/skills/save-tool";

/*
 * 对标 Codex CLI 的一轮：系统提示和工具定义更短，浏览器的用法随检索结果给，技能只列清单、要用才读。
 * 体积守卫在 prompt-budget.test.ts；这里钉三件事各自的行为。
 */

const said = (text: string) => ({
  messages: [{ id: "q", role: "user" as const, content: text }],
});

const BODY_MARK = "BODY-ONLY-7731";
const CHECK = "test -s <dir>/out.txt";

function own(name: string, when: string, fast = false): PickableSkill {
  const rendered = renderSkill({
    name,
    when,
    steps: ["读输入", `写输出 ${BODY_MARK}`],
    pitfalls: [],
    verify: "行数对得上",
    scope: "self",
    ...(fast
      ? { fastPath: "printf x > <dir>/out.txt", fastPathCheck: CHECK }
      : {}),
  });
  return {
    slug: `auto-${Buffer.from(name).toString("hex").slice(-10)}`,
    title: rendered.title,
    summary: rendered.summary,
    instructions: rendered.instructions,
  };
}

const REPORT = own("会议纪要转待办", "收到会议纪要，要整理成待办表时", true);
const REQUEST = "请把这份会议纪要整理成待办表，每个人一行";
const UNRELATED = "帮我订一张下周去上海的机票并比较价格";

describe("技能：清单在提示里，正文不在", () => {
  /*
   * 用户 2026-11-22 批准（第十二轮）：对上的第一条带快路径时，这一轮开头就附快路径（FAST_PATH_ADVICE + 快路径那一段），
   * 员工不必先 read_skill。原来这条断言钉的是「没有快路径脚本、没有先按快路径做的提示」。步骤正文仍不在。
   */
  test("对得上的那条标 MATCH 排在最前，附快路径但没有步骤正文，每行不超过 160 字符", () => {
    const other = own("周报整理", "每周把销售数据整理成周报");
    const text = ownSkillsGuidance(said(REQUEST), [other, REPORT]) ?? "";
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`(id: ${REPORT.slug})`);
    expect(lines[0]).toContain("[MATCH]");
    expect(lines[1]).toContain(`(id: ${other.slug})`);
    expect(lines[1]).not.toContain("[MATCH]");
    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(OWN_SKILL_LINE_CHARS);
    expect(text).toContain(READ_SKILL_TOOL);
    expect(text).not.toContain(BODY_MARK);
    expect(text).toContain("printf x");
    expect(text).toContain(FAST_PATH_ADVICE);
    expect(text).toContain(CHECK);
    expect(text).toContain("fast path is loaded");
    expect(text).not.toContain("None is loaded");
  });

  test("对上但没有快路径、没对上：和以前一样，只有清单，没有快路径提示", () => {
    const plain = own("会议纪要转待办", "收到会议纪要，要整理成待办表时");
    const matchedPlain = ownSkillsGuidance(said(REQUEST), [plain]) ?? "";
    expect(matchedPlain).toContain("None is loaded");
    expect(matchedPlain).toContain("[MATCH]");
    expect(matchedPlain).toContain("read them first");
    expect(matchedPlain).not.toContain(FAST_PATH_ADVICE);
    expect(matchedPlain).not.toContain("###");
    const unmatched = ownSkillsGuidance(said(UNRELATED), [REPORT]) ?? "";
    expect(unmatched).toContain("None is loaded");
    expect(unmatched).not.toContain("[MATCH]");
    expect(unmatched).not.toContain(FAST_PATH_ADVICE);
    expect(unmatched).not.toContain("printf x");
  });

  test("快路径段超过上限：不附，照旧只给清单（截断的脚本跑不了）", () => {
    const long = own("会议纪要转待办", "收到会议纪要，要整理成待办表时", true);
    const big: PickableSkill = {
      ...long,
      instructions: renderSkill({
        name: "会议纪要转待办",
        when: "收到会议纪要，要整理成待办表时",
        steps: ["读输入"],
        pitfalls: [],
        verify: "行数对得上",
        scope: "self",
        fastPath: `printf x > <dir>/out.txt # ${"长".repeat(MATCHED_FAST_PATH_CHARS)}`,
        fastPathCheck: CHECK,
      }).instructions,
    };
    expect(fastPathSection(big.instructions ?? "")).toBeUndefined();
    const text = ownSkillsGuidance(said(REQUEST), [big]) ?? "";
    expect(text).toContain("[MATCH]");
    expect(text).toContain("None is loaded");
    expect(text).not.toContain(FAST_PATH_ADVICE);
    expect(text).not.toContain("printf x");
  });

  test("复盘存得下的最长快路径（各项都到上限）也整段附上", () => {
    const longest = own(
      "会议纪要转待办",
      "收到会议纪要，要整理成待办表时",
      true,
    );
    const full: PickableSkill = {
      ...longest,
      instructions: renderSkill({
        name: "会议纪要转待办",
        when: "收到会议纪要，要整理成待办表时",
        steps: ["读输入"],
        pitfalls: [],
        verify: "行数对得上",
        scope: "self",
        fastPathNeeds: "需".repeat(SKILL_FIELD_LIMITS.fastPathNeeds),
        fastPath: `printf x > <dir>/out.txt # ${"长".repeat(SKILL_FIELD_LIMITS.fastPath - 30)}`,
        fastPathCheck: `test -s <dir>/out.txt ${"#".repeat(SKILL_FIELD_LIMITS.fastPathCheck - 22)}`,
      }).instructions,
    };
    expect(fastPathSection(full.instructions ?? "")).toBeDefined();
    const text = ownSkillsGuidance(said(REQUEST), [full]) ?? "";
    expect(text).toContain(FAST_PATH_ADVICE);
    expect(text).toContain("printf x");
  });

  test("两条都对上：只附第一条的快路径", () => {
    const first = own("会议纪要转待办", "收到会议纪要，要整理成待办表时", true);
    const secondRaw = own(
      "会议纪要整理待办单",
      "收到会议纪要，要整理成待办表时",
      true,
    );
    const second: PickableSkill = {
      ...secondRaw,
      instructions: (secondRaw.instructions ?? "").replace(
        "printf x",
        "printf SECOND-ONE",
      ),
    };
    const text = ownSkillsGuidance(said(REQUEST), [first, second]) ?? "";
    expect(text.match(/\[MATCH\]/g)).toHaveLength(2);
    expect(text.match(/###/g)).toHaveLength(1);
    expect(text.split(FAST_PATH_ADVICE)).toHaveLength(2);
    // 第一条按现有排序（分高的在前，同分按 id）；附的就是清单里排在最前的那条。
    const firstLine =
      text.split("\n").find((line) => line.startsWith("- ")) ?? "";
    const head = [first, second].find((skill) =>
      firstLine.includes(`(id: ${skill.slug})`),
    );
    expect(text).toContain(`### ${head?.title} (id: ${head?.slug})`);
    expect(text).toContain(head === first ? "printf x" : "printf SECOND-ONE");
    expect(text).not.toContain(
      head === first ? "printf SECOND-ONE" : "printf x >",
    );
  });

  test("快路径段只取快路径：标题行、前提、脚本、校验命令，不带适用场景和步骤", () => {
    const section = fastPathSection(REPORT.instructions ?? "") ?? "";
    expect(section.startsWith("快路径（")).toBe(true);
    expect(section).toContain("printf x > <dir>/out.txt");
    expect(section).toContain(CHECK);
    expect(section).not.toContain("适用场景");
    expect(section).not.toContain("步骤：");
    expect(section.length).toBeLessThanOrEqual(MATCHED_FAST_PATH_CHARS);
    expect(fastPathSection("适用场景：x\n\n步骤：\n1. a")).toBeUndefined();
  });

  test("附快路径的指引同一句话每次字节相同", () => {
    expect(ownSkillsGuidance(said(REQUEST), [REPORT])).toBe(
      ownSkillsGuidance(said(REQUEST), [REPORT]),
    );
  });

  test("没有对得上的：条数不多时仍列出来让员工自己判断；太多或只是一句「继续」时不放", () => {
    const few = [own("甲", "做甲这类事的时候"), own("乙", "做乙这类事的时候")];
    expect(ownSkillsGuidance(said(UNRELATED), few)).toContain(
      "None clearly fits",
    );
    expect(ownSkillsGuidance(said(UNRELATED), few)).not.toContain("[MATCH]");
    expect(ownSkillsGuidance(said("继续"), few)).toBeUndefined();
    const many = Array.from({ length: OWN_SKILL_LIST_MAX + 1 }, (_, index) =>
      own(`技能${index}`, `做第${index}种事的时候`),
    );
    expect(ownSkillsGuidance(said(UNRELATED), many)).toBeUndefined();
    // 很多条时对上的那条仍然放，别的不放。
    const lines = (ownSkillsGuidance(said(REQUEST), [REPORT, ...many]) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[MATCH]");
  });

  test("清单最多 8 条，同一批技能同一句话每次字节相同，和顺序无关", () => {
    const held = Array.from({ length: OWN_SKILL_LIST_MAX }, (_, index) =>
      own(`技能${index}`, `做第${index}种事的时候`),
    );
    const once = ownSkillsGuidance(said(UNRELATED), held);
    expect(
      (once ?? "").split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(OWN_SKILL_LIST_MAX);
    expect(ownSkillsGuidance(said(UNRELATED), [...held].reverse())).toBe(once);
  });

  test("人写的技能不进清单；人点了命令就是那一条的正文，照旧", () => {
    const human: PickableSkill = {
      slug: "pirate-haiku",
      title: "Pirate haiku",
      instructions: "Write a haiku like a pirate.",
    };
    expect(ownSkillsGuidance(said(REQUEST), [human])).toBeUndefined();
    const picked = builtInSkillGuidanceFor(
      {
        messages: [{ id: "q", role: "user", content: "/pirate-haiku 写一首" }],
        forwardedProps: {},
      },
      [human, REPORT],
    );
    expect(picked).toContain("Write a haiku like a pirate.");
    expect(picked).not.toContain("[MATCH]");
  });
});

describe("读技能：全文加快路径的提示，留在历史里", () => {
  test("带快路径的技能：全文，加上先按快路径做的那段提示（钉住的四句都在）", () => {
    const text = readSkillText({
      slug: REPORT.slug,
      title: REPORT.title,
      instructions: REPORT.instructions ?? "",
    });
    expect(text).toContain(BODY_MARK);
    expect(text).toContain(CHECK);
    expect(text).toContain(FAST_PATH_ADVICE);
    for (const phrase of [
      "先按技能的快路径做",
      "不要先逐个打开文件",
      "用一条命令一次查齐",
      "不必去翻以前做过的任务目录",
    ])
      expect(text).toContain(phrase);
  });

  test("没有快路径的技能：只有全文，没有那段提示", () => {
    const plain = own("周报整理", "每周把销售数据整理成周报");
    const text = readSkillText({
      slug: plain.slug,
      title: plain.title,
      instructions: plain.instructions ?? "",
    });
    expect(text).toContain(BODY_MARK);
    expect(text).not.toContain("先按技能的快路径做");
  });

  test("校验命令由服务器从对得上的技能里取，不看提示里写了什么", () => {
    expect(matchedSkillChecks(said(REQUEST), [REPORT])).toEqual([CHECK]);
    expect(matchedSkillChecks(said(UNRELATED), [REPORT])).toEqual([]);
    // 第十二轮：快路径附在清单后面，校验那一行现在也在提示里；但「已验」仍由服务器从技能里算，上面两条不变。
    const text = ownSkillsGuidance(said(REQUEST), [REPORT]) ?? "";
    expect(text).toContain(CHECK);
  });

  test("read_skill 当作熊宝自带的工具，不当作外部系统列在应用段里", () => {
    expect(isDeploymentTool(READ_SKILL_TOOL)).toBe(true);
  });
});

describe("浏览器的用法随检索结果给", () => {
  const client = (name: string) => ({
    name,
    ref: `client/${name}`,
    description: `The ${name} tool.`,
    parameters: z.object({ url: z.string().optional() }),
    execute: async () => "",
  });
  const waiting = [
    client("computer_navigate"),
    client("computer_snapshot"),
    client("generate_image"),
  ];
  const tool = (options: { fallback?: boolean } = {}) =>
    searchToolsTool(waiting, {
      slim: true,
      afterFound: (names) =>
        names.some(isBrowserTool)
          ? slimBrowserGuidance({ searchFallback: options.fallback === true })
          : undefined,
    });

  test("搜到浏览器工具：结果后面带着浏览器的做法和网页按钮的批准规则；搜到别的不带", async () => {
    const browser = String(await tool().execute({ query: "browser" }));
    expect(browser.split("\n")[0]).toBe(
      "Tools found: computer_navigate, computer_snapshot",
    );
    expect(browser).toContain("computer_snapshot");
    expect(browser).toContain("snapshotId");
    expect(browser).toContain("computer_request_help");
    expect(browser).toContain(APPROVAL_GUIDANCE_WEB_AND_HANDED_OVER[0]);
    const image = String(await tool().execute({ query: "image" }));
    expect(image.split("\n")[0]).toBe("Tools found: generate_image");
    expect(image).not.toContain("snapshotId");
  });

  test("web_search 出错时的浏览器退路也在里面（有搜索退路时）", () => {
    expect(slimBrowserGuidance({ searchFallback: true })).toContain(
      "baidu.com",
    );
    expect(slimBrowserGuidance()).not.toContain("baidu.com");
  });

  test("描述只用一行说有哪几类，不逐个列名字", () => {
    const description = tool().description;
    expect(description).toContain("browser");
    expect(description).toContain("image/video");
    expect(description).not.toContain("computer_navigate");
    expect(description.length).toBeLessThan(300);
    expect(
      deferredCategories(["generate_image", "computer_glob", "nothing"]),
    ).toBe("image/video, files");
  });

  test("系统提示里的电脑段只剩几句；提问段不再带网页按钮的规则，但付款、改密码仍交给本人", () => {
    const holding = { search: true, personal: false, browserSearch: false };
    const short = slimComputerGuidance({ ...holding, browserDeferred: true });
    expect(short.length).toBeLessThan(500);
    expect(short).toContain("search_tools");
    expect(short).not.toContain("computer_snapshot");
    // 同一个函数不带这个标记时，整段照旧。
    expect(slimComputerGuidance(holding)).toContain("computer_snapshot");

    const apps = (web: boolean) => slimAskingGuidance({ apps: true, web });
    expect(apps(false)).not.toContain("Add comment");
    expect(apps(true)).toContain("Add comment");
    for (const web of [false, true]) {
      expect(apps(web)).toContain("付款、购买、转账");
      expect(apps(web)).toContain("mcp__");
      expect(apps(web)).toContain("你不要先问");
      expect(apps(web)).toContain("hard to undo");
    }
  });

  test("web_search 的退路：浏览器排在检索后面时只说一句，做法在检索结果里", () => {
    const names = ["web_search", "web_fetch"];
    const deferred =
      slimWebResearchGuidance(names, {
        browser: true,
        browserDeferred: true,
      }) ?? "";
    expect(deferred).not.toContain("baidu.com");
    expect(deferred).toContain("search_tools");
    expect(slimWebResearchGuidance(names, { browser: true }) ?? "").toContain(
      "baidu.com",
    );
  });
});

describe("交付规则和规约合成一段", () => {
  test("有规约：一段里两样都在；没有规约：只有规则", () => {
    const merged = slimDeliveryGuidance("【熊宝交付规约】1 接活先回");
    expect(merged).toContain("file-sharing, transfer or paste site");
    expect(merged).toContain("【熊宝交付规约】");
    expect(slimDeliveryGuidance(undefined)).not.toContain("【熊宝交付规约】");
  });
});

describe("发给模型的工具定义去掉用不上的约束", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1 },
      items: { type: "array", default: [], items: { type: "string" } },
      timeout: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["path"],
  };
  const sent = (strict: boolean) =>
    JSON.stringify(
      slimModelTools(
        [{ type: "function", name: "x_tool", inputSchema: schema }],
        { strict },
      )[0]?.inputSchema,
    );

  test("普通聊天接口：minLength、minimum、exclusiveMinimum、default 不发；参数名和必填项不变", () => {
    const text = sent(false);
    for (const key of ["minLength", "minimum", "exclusiveMinimum", "default"])
      expect(text).not.toContain(key);
    expect(text).toContain('"required":["path"]');
    for (const name of ["path", "limit", "items", "timeout"])
      expect(text).toContain(`"${name}"`);
  });

  test("严格模式的接口（Responses）照旧原样", () => {
    expect(sent(true)).toContain("minLength");
  });
});

describe("浏览器工具直接带着时，浏览器规则留在系统提示里", () => {
  test("只有浏览器工具确实排在 search_tools 后面才挪走规则", () => {
    expect(
      browserRulesDeferred(true, ["computer_navigate", "save_learned_skill"]),
    ).toBe(true);
    // 排在后面的只有记忆、技能这些，浏览器工具直接带着：规则不能挪走。
    expect(browserRulesDeferred(true, ["save_learned_skill", "recall"])).toBe(
      false,
    );
    expect(browserRulesDeferred(false, ["computer_navigate"])).toBe(false);
  });
});
