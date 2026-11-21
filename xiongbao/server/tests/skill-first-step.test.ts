import { describe, expect, test } from "bun:test";
import {
  FAST_PATH_BOARD_ADVICE,
  relatedSkillsGuidance,
  relatedSkillsParts,
  skillGuidanceParts,
} from "../src/plugins/picked-skill";
import { renderSkill, type SkillDraft } from "../src/skills/save-tool";

/*
 * 对得上的自己的技能：整段正文（含快路径和校验）只在本轮第一步给，系统提示里每一步只留一行指引；
 * 看板卡的一轮命中快路径时，再说一句不单独列计划、不另写说明文件。
 */

const SCRIPT = "python3 - <<'PY'\nprint('minutes')\nPY";
const CHECK = "awk 'END{print NR}' <dir>/actions.csv";
const draft: SkillDraft = {
  name: "会议纪要转待办CSV与邮件草稿",
  when: "收到会议纪要（.md），要整理成待办表（.csv）并给每位负责人写邮件草稿时",
  steps: ["读纪要", "写 CSV", "写草稿"],
  pitfalls: ["纪要第一行是标题，要跳过"],
  verify: "actions.csv 行数等于待办条数加表头",
  scope: "self",
  fastPath: SCRIPT,
  fastPathNeeds: "目录里有纪要 .md",
  fastPathCheck: CHECK,
};
const held = (fast: boolean) => [
  {
    slug: "auto-0123456789",
    title: draft.name,
    summary: draft.when,
    instructions: renderSkill({
      ...draft,
      ...(fast ? {} : { fastPath: undefined }),
    }).instructions,
  },
];
const said = (content: string) => ({
  messages: [{ id: "q", role: "user" as const, content }],
  forwardedProps: {},
});
const REQUEST = "把会议纪要整理成待办 csv，再给每位负责人写邮件草稿";

describe("第一步给全文，之后一行", () => {
  test("firstStep 带快路径、校验和正文；system 只有一行指引，没有快路径块", () => {
    const parts = relatedSkillsParts(said(REQUEST), held(true));
    expect(parts?.firstStep).toContain("先按技能的快路径做");
    expect(parts?.firstStep).toContain(SCRIPT);
    expect(parts?.firstStep).toContain(`快路径校验命令：${CHECK}`);
    const system = parts?.system ?? "";
    expect(system).toContain("auto-0123456789");
    expect(system).toContain("已在本轮第一步给出，快路径照做");
    expect(system).toContain("refine_skill");
    expect(system).not.toContain(SCRIPT);
    expect(system).not.toContain("先按技能的快路径做");
    expect(system).not.toContain(CHECK);
  });

  test("没有快路径的技能：指引里不说快路径照做", () => {
    const parts = relatedSkillsParts(said(REQUEST), held(false));
    expect(parts?.system).toContain("已在本轮第一步给出");
    expect(parts?.system).not.toContain("快路径照做");
  });

  test("完整形式（harness 路径）仍是原来那一整段", () => {
    const full = relatedSkillsGuidance(said(REQUEST), held(true)) ?? "";
    expect(full).toContain("You have done this kind of work before");
    expect(full).toContain(SCRIPT);
    expect(full).toContain("先按技能的快路径做");
    expect(full).not.toContain("已在本轮第一步给出");
  });

  test("没有对得上的：skillGuidanceParts 不凭空造", () => {
    expect(skillGuidanceParts(said("今天天气怎么样"), [])).toBeUndefined();
    const parts = skillGuidanceParts(said(REQUEST), held(true));
    expect(parts?.firstStep).toContain(SCRIPT);
  });
});

describe("看板卡的一轮命中快路径：不单独列计划，不另写说明文件", () => {
  test("看板轮 + 快路径：说接下卡片、跑快路径和校验、交付；不 update_plan、不写 NOTES.md", () => {
    const parts = relatedSkillsParts(said(REQUEST), held(true), {
      boardCard: true,
    });
    expect(parts?.firstStep).toContain(FAST_PATH_BOARD_ADVICE);
    expect(FAST_PATH_BOARD_ADVICE).toContain("accept_task");
    expect(FAST_PATH_BOARD_ADVICE).toContain("deliver_task");
    expect(FAST_PATH_BOARD_ADVICE).toContain("不要单独调用 update_plan");
    expect(FAST_PATH_BOARD_ADVICE).toContain("NOTES.md");
    // 原来的三句话照旧在。
    expect(parts?.firstStep).toContain("先按技能的快路径做");
    expect(parts?.firstStep).toContain("不要先逐个打开文件");
    expect(parts?.firstStep).toContain("用一条命令一次查齐");
  });

  test("不是看板轮，或者技能没有快路径：不说，计划要求照旧", () => {
    const chat = relatedSkillsParts(said(REQUEST), held(true));
    expect(chat?.firstStep).not.toContain(FAST_PATH_BOARD_ADVICE);
    const plain = relatedSkillsParts(said(REQUEST), held(false), {
      boardCard: true,
    });
    expect(plain?.firstStep).not.toContain(FAST_PATH_BOARD_ADVICE);
  });

  test("完整形式在看板轮也带这句", () => {
    const full =
      relatedSkillsGuidance(said(REQUEST), held(true), { boardCard: true }) ??
      "";
    expect(full).toContain(FAST_PATH_BOARD_ADVICE);
  });
});
