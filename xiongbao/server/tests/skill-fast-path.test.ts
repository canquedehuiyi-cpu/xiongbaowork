import { describe, expect, test } from "bun:test";
import { unverifiedChanges } from "../../shared/verify";
import { parseDraft, RETRO_SYSTEM } from "../src/learning/retrospect";
import {
  fastPathChecksIn,
  RELATED_SKILL_CHARS,
  relatedSkillsGuidance,
  shortSkillBody,
} from "../src/plugins/picked-skill";
import { renderSkill, type SkillDraft } from "../src/skills/save-tool";

/*
 * 重复任务第二次没有更快：技能只写了泛泛的步骤，员工照样先摸索。技能要带上「快路径」：最终的脚本或命令、
 * 前提、一条命令的校验。复盘要求写它，简短形式优先保留它，注入提示叫员工先按它做，跑过技能自带的校验
 * 就不再被「改完必验」多拖一步。
 */

const SCRIPT =
  "python3 - <<'PY'\nimport csv, pathlib\nd = pathlib.Path('<dir>')\n# 解析纪要，写 actions.csv 和 drafts/\nPY";
const CHECK = "awk 'END{print NR}' <dir>/actions.csv";

const draft: SkillDraft = {
  name: "会议纪要转待办CSV与邮件草稿",
  when: "收到会议纪要（.md），要整理成待办表（.csv）并给每位负责人写邮件草稿时",
  steps: ["读纪要", "写 CSV", "写草稿"],
  pitfalls: ["纪要第一行是标题，要跳过"],
  verify: "actions.csv 行数等于待办条数加表头",
  scope: "self",
  fastPath: SCRIPT,
  fastPathNeeds: "目录里有纪要 .md，机器上有 python3",
  fastPathCheck: CHECK,
};

const SECOND_REQUEST = "把会议纪要整理成待办 csv，再给每位负责人写邮件草稿";

describe("复盘提示要求写快路径", () => {
  test("RETRO_SYSTEM 说明：脚本或命令做成的事，把可复用的最终脚本写进 fastPath，并带前提和校验", () => {
    expect(RETRO_SYSTEM).toContain("fastPath");
    expect(RETRO_SYSTEM).toContain("fast path");
    expect(RETRO_SYSTEM).toContain("fastPathNeeds");
    expect(RETRO_SYSTEM).toContain("fastPathCheck");
    expect(RETRO_SYSTEM).toContain("single command");
    expect(RETRO_SYSTEM).toContain("placeholder");
  });

  test("模型答出的快路径三项保留在草稿里；没有快路径的草稿照旧能用", () => {
    const parsed = parseDraft(JSON.stringify({ skill: draft }));
    expect(parsed?.fastPath).toBe(SCRIPT);
    expect(parsed?.fastPathNeeds).toBe(draft.fastPathNeeds);
    expect(parsed?.fastPathCheck).toBe(CHECK);
    const { fastPath, fastPathNeeds, fastPathCheck, ...plain } = draft;
    const old = parseDraft(JSON.stringify({ skill: plain }));
    expect(old?.name).toBe(draft.name);
    expect(old).not.toHaveProperty("fastPath");
  });

  test("存下的技能正文里有「快路径」一段：前提、脚本、校验命令，排在步骤之前", () => {
    const { instructions } = renderSkill(draft);
    expect(instructions).toContain("快路径");
    expect(instructions).toContain(SCRIPT);
    expect(instructions).toContain("前提：目录里有纪要 .md");
    expect(instructions).toContain(`快路径校验命令：${CHECK}`);
    expect(instructions.indexOf("快路径")).toBeLessThan(
      instructions.indexOf("步骤："),
    );
    expect(
      renderSkill({ ...draft, fastPath: undefined }).instructions,
    ).not.toContain("快路径");
  });
});

describe("简短形式优先保留快路径和校验", () => {
  const long = (extra: string) =>
    renderSkill({
      ...draft,
      steps: Array.from(
        { length: 12 },
        (_, index) => `第 ${index} 步：${"很长的步骤。".repeat(30)}`,
      ),
      pitfalls: [`坑点：${"很长的坑点。".repeat(60)}`],
      ...(extra ? { verify: extra } : {}),
    }).instructions;

  test("正文超长时，快路径、校验命令和「怎么确认做对了」都留着，步骤和坑点被挤掉", () => {
    const body = long("");
    expect(body.length).toBeGreaterThan(RELATED_SKILL_CHARS * 2);
    const shown = shortSkillBody(body, RELATED_SKILL_CHARS);
    expect(shown.length).toBeLessThanOrEqual(RELATED_SKILL_CHARS + 1);
    expect(shown).toContain(SCRIPT);
    expect(shown).toContain(`快路径校验命令：${CHECK}`);
    expect(shown).toContain("怎么确认做对了");
    expect(shown).toContain("适用场景");
    expect(shown).not.toContain("坑点：");
  });

  test("没有快路径的技能，截断照旧只取开头", () => {
    const body = `适用场景：x\n\n步骤：\n${"1. 很长。\n".repeat(400)}`;
    expect(shortSkillBody(body, RELATED_SKILL_CHARS)).toBe(
      `${body.slice(0, RELATED_SKILL_CHARS)}…`,
    );
  });

  test("放得下就原样给", () => {
    const { instructions } = renderSkill(draft);
    expect(shortSkillBody(instructions, RELATED_SKILL_CHARS)).toBe(
      instructions,
    );
  });
});

describe("注入提示叫员工先按快路径做", () => {
  const held = [
    {
      slug: "auto-0123456789",
      title: draft.name,
      summary: draft.when,
      instructions: renderSkill(draft).instructions,
    },
  ];
  const said = (content: string) => ({
    messages: [{ id: "q", role: "user" as const, content }],
  });

  test("有快路径时：先按快路径做，对不上再摸索；一步写好脚本运行，不先逐个打开文件", () => {
    const guidance = relatedSkillsGuidance(said(SECOND_REQUEST), held) ?? "";
    expect(guidance).toContain("先按技能的快路径做");
    expect(guidance).toContain("对不上");
    expect(guidance).toContain("不要先逐个打开文件");
    expect(guidance).toContain(SCRIPT);
    expect(guidance).toContain("You have done this kind of work before");
  });

  test("没有快路径的技能：不说这句，提示照旧", () => {
    const plain = [
      {
        ...held[0],
        instructions: renderSkill({ ...draft, fastPath: undefined })
          .instructions,
      },
    ];
    const guidance = relatedSkillsGuidance(said(SECOND_REQUEST), plain) ?? "";
    expect(guidance).toContain("You have done this kind of work before");
    expect(guidance).not.toContain("快路径");
  });

  test("注入的文字里能读出技能自带的校验命令", () => {
    const guidance = relatedSkillsGuidance(said(SECOND_REQUEST), held) ?? "";
    expect(fastPathChecksIn(guidance)).toEqual([CHECK]);
    expect(fastPathChecksIn("没有这一行")).toEqual([]);
  });
});

describe("跑过技能自带的校验就算已校验", () => {
  const writeScript = {
    name: "computer_run_command",
    input: {
      command:
        "cat > /work/run.py <<'EOF'\nprint(1)\nEOF\npython3 /work/run.py",
    },
  };

  test("脚本写在 .py 里再运行，没跑校验：照旧提醒", () => {
    expect(unverifiedChanges([writeScript])).toEqual(["/work/run.py"]);
  });

  test("之后跑了技能的校验命令（<dir> 换成这次的目录）：不再提醒", () => {
    const calls = [
      writeScript,
      {
        name: "computer_run_command",
        input: { command: "awk 'END{print NR}' /work/eval/actions.csv" },
      },
    ];
    expect(unverifiedChanges(calls, [CHECK])).toEqual([]);
  });

  test("写脚本和校验在同一条命令里，校验排在后面：也算", () => {
    const calls = [
      {
        name: "computer_run_command",
        input: {
          command:
            "cat > /work/run.py <<'EOF'\nprint(1)\nEOF\npython3 /work/run.py; awk 'END{print NR}' /work/eval/actions.csv",
        },
      },
    ];
    expect(unverifiedChanges(calls, [CHECK])).toEqual([]);
  });

  test("命令写的文件就是校验命令检查的文件（最常见的快路径）：也算", () => {
    const calls = [
      {
        name: "computer_run_command",
        input: {
          command:
            "printf 'a,b\\n' > eval/x/actions.csv && awk 'END{print NR}' eval/x/actions.csv",
        },
      },
    ];
    expect(unverifiedChanges(calls, [CHECK])).toEqual([]);
    // 技能没带校验命令时，同一条命令照旧是「写了没验」。
    expect(unverifiedChanges(calls)).toEqual(["eval/x/actions.csv"]);
  });

  test("校验跑在最后一次改动之前不算", () => {
    const calls = [
      {
        name: "computer_run_command",
        input: { command: "awk 'END{print NR}' /work/eval/actions.csv" },
      },
      writeScript,
    ];
    expect(unverifiedChanges(calls, [CHECK])).toEqual(["/work/run.py"]);
  });

  test("别的命令不冒充技能的校验", () => {
    const calls = [
      writeScript,
      { name: "computer_run_command", input: { command: "ls /work" } },
    ];
    expect(unverifiedChanges(calls, [CHECK])).toEqual(["/work/run.py"]);
  });
});
