import { describe, expect, test } from "bun:test";
import {
  emptyRoleProfile,
  ROLE_LIMITS,
  type RoleProfile,
  roleProfileFromMarkdown,
  roleProfileToMarkdown,
  sameRoleProfile,
  validateRoleProfile,
} from "../../shared/role-profile";

/**
 * Story ROLE1 (spec §3.6, §6.1): the fixed Markdown format of a role profile, as pure functions.
 * Export then import gives back exactly what was exported; a file that does not fit says which part
 * is wrong instead of losing it.
 */

const full: RoleProfile = {
  identity: {
    title: "Backend Engineer",
    roleDescription: "按需求写实现、跑测试。\n改动说明写清为什么。",
  },
  persona: {
    tone: "直接、简短。",
    principles: "先读现有代码再动手。\n\n改动最小且可验证。",
    habits: "完成后说明跑过哪些检查。",
  },
  bible: "# 术语表\n\n- PR：合并请求\n\n## 发布流程\n\n1. 打标签\n2. 等 CI",
};

const EXPECTED_MARKDOWN = `# 身份

头衔：Backend Engineer

## 职责

按需求写实现、跑测试。
改动说明写清为什么。

# 人设

## 性格语气

直接、简短。

## 工作守则

先读现有代码再动手。

改动最小且可验证。

## 口头约束

完成后说明跑过哪些检查。

# 手册

# 术语表

- PR：合并请求

## 发布流程

1. 打标签
2. 等 CI
`;

function parsed(markdown: string): RoleProfile {
  const result = roleProfileFromMarkdown(markdown);
  if (!result.ok) {
    throw new Error(`${result.section}: ${result.message} (${result.line})`);
  }
  return result.profile;
}

function refusal(markdown: string) {
  const result = roleProfileFromMarkdown(markdown);
  if (result.ok) throw new Error("expected the file to be refused");
  return result;
}

describe("export", () => {
  test("writes the fixed format, Chinese headings, the handbook last and verbatim", () => {
    expect(roleProfileToMarkdown(full)).toBe(EXPECTED_MARKDOWN);
  });

  test("an empty profile is the bare skeleton", () => {
    expect(roleProfileToMarkdown(emptyRoleProfile())).toBe(
      "# 身份\n\n头衔：\n\n## 职责\n\n# 人设\n\n## 性格语气\n\n## 工作守则\n\n## 口头约束\n\n# 手册\n",
    );
  });
});

describe("round trip: export then import is the same profile", () => {
  const cases: [string, RoleProfile][] = [
    ["a full profile whose handbook has its own headings", full],
    ["an empty profile", emptyRoleProfile()],
    [
      "persona only, as the old persona templates were copied",
      {
        ...emptyRoleProfile(),
        persona: { tone: "温和", principles: "", habits: "不说空话" },
      },
    ],
    [
      "fields with lines that look like headings or start with a backslash",
      {
        identity: {
          title: "# 不是标题",
          roleDescription: "# 一级\n## 二级\n\\转义",
        },
        persona: {
          tone: "甲\n  # 缩进的井号",
          principles: "\\\\两个反斜杠",
          habits: "#没有空格",
        },
        bible: "",
      },
    ],
    [
      "a handbook that repeats every section heading",
      {
        ...emptyRoleProfile(),
        bible: "# 身份\n头衔：假的\n# 人设\n# 未知\n# 手册",
      },
    ],
    [
      "text at every limit",
      {
        identity: {
          title: "题".repeat(ROLE_LIMITS.title),
          roleDescription: "职".repeat(ROLE_LIMITS.roleDescription),
        },
        persona: {
          tone: "语".repeat(ROLE_LIMITS.personaPart),
          principles: "则".repeat(ROLE_LIMITS.personaPart),
          habits: "🐻".repeat(ROLE_LIMITS.personaPart),
        },
        bible: "册".repeat(ROLE_LIMITS.bible),
      },
    ],
    [
      "markdown lists, code fences and tables in the handbook",
      {
        ...emptyRoleProfile(),
        identity: { title: "QA", roleDescription: "把验收标准变成用例。" },
        bible:
          "```ts\n# not a heading in code\nconst a = 1;\n```\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |",
      },
    ],
    [
      "a title with a colon in it",
      {
        ...emptyRoleProfile(),
        identity: { title: "运营：数据与进度", roleDescription: "" },
      },
    ],
  ];
  for (const [name, profile] of cases) {
    test(name, () => {
      const normalised = validateRoleProfile(profile);
      if (!normalised.ok) throw new Error(normalised.message);
      expect(normalised.profile).toEqual(profile);
      const back = parsed(roleProfileToMarkdown(profile));
      expect(back).toEqual(profile);
      expect(sameRoleProfile(back, profile)).toBe(true);
    });
  }
});

describe("import accepts", () => {
  test("English headings and Title:", () => {
    expect(
      parsed(
        "# Identity\nTitle: Code Reviewer\n## Responsibilities\n审差异与风险。\n# Persona\n## Tone\n严格\n## Principles\n按规格轴判断\n## Habits\n指出文件与行\n# Bible\n清单",
      ),
    ).toEqual({
      identity: { title: "Code Reviewer", roleDescription: "审差异与风险。" },
      persona: {
        tone: "严格",
        principles: "按规格轴判断",
        habits: "指出文件与行",
      },
      bible: "清单",
    });
  });

  test("Windows line endings, a byte-order mark and mixed-case English headings", () => {
    expect(
      parsed(
        "﻿# 身份\r\n头衔: 测试\r\n# PERSONA\r\n## tone\r\n冷静\r\n# bible\r\n",
      ),
    ).toEqual({
      ...emptyRoleProfile(),
      identity: { title: "测试", roleDescription: "" },
      persona: { tone: "冷静", principles: "", habits: "" },
    });
  });

  test("missing persona sub-sections, which read as empty", () => {
    expect(parsed("# 身份\n头衔：甲\n# 人设\n# 手册\n正文").persona).toEqual({
      tone: "",
      principles: "",
      habits: "",
    });
  });

  test("blank lines before the first heading", () => {
    expect(
      parsed("\n\n# 身份\n头衔：甲\n# 人设\n# 手册\n").identity.title,
    ).toBe("甲");
  });
});

describe("import refuses, naming the part", () => {
  test("an unknown first-level heading, with its text and line", () => {
    expect(refusal("# 身份\n头衔：甲\n# 技能\n内容\n# 人设\n# 手册")).toEqual({
      ok: false,
      section: "技能",
      message: "未知的一级标题「技能」。",
      line: 3,
    });
  });

  test("a missing section", () => {
    expect(refusal("# 身份\n头衔：甲\n# 手册\n正文")).toMatchObject({
      section: "人设",
      message: "缺少一级标题「# 人设」。",
    });
    expect(refusal("# 身份\n头衔：甲\n# 人设\n")).toMatchObject({
      section: "手册",
    });
    expect(refusal("# 人设\n# 手册\n")).toMatchObject({ section: "身份" });
  });

  test("an identity without its title line", () => {
    expect(refusal("# 身份\n## 职责\n写代码\n# 人设\n# 手册")).toMatchObject({
      section: "身份",
      message: "「身份」缺少「头衔：」一行。",
    });
  });

  test("text that belongs to no heading", () => {
    expect(refusal("前言\n# 身份\n头衔：甲\n# 人设\n# 手册")).toMatchObject({
      section: "文件开头",
      line: 1,
    });
    expect(refusal("# 身份\n头衔：甲\n随手一行\n# 人设\n# 手册")).toMatchObject(
      {
        section: "身份",
        line: 3,
      },
    );
    expect(refusal("# 身份\n头衔：甲\n# 人设\n散落的话\n# 手册")).toMatchObject(
      {
        section: "人设",
        line: 4,
      },
    );
  });

  test("an unknown second-level heading", () => {
    expect(
      refusal("# 身份\n头衔：甲\n# 人设\n## 爱好\n下棋\n# 手册"),
    ).toMatchObject({
      section: "人设",
      message: "「人设」下未知的二级标题「爱好」。",
      line: 4,
    });
    expect(refusal("# 身份\n头衔：甲\n## 简介\n# 人设\n# 手册")).toMatchObject({
      section: "身份",
      line: 3,
    });
  });

  test("a repeated heading", () => {
    expect(refusal("# 身份\n头衔：甲\n# 身份\n# 人设\n# 手册")).toMatchObject({
      section: "身份",
      line: 3,
    });
    expect(
      refusal(
        "# 身份\n头衔：甲\n# 人设\n## 性格语气\n甲\n## 性格语气\n乙\n# 手册",
      ),
    ).toMatchObject({ section: "性格语气", line: 6 });
  });

  test("an over-long part, by its name", () => {
    const tooLong = (field: string, text: string) =>
      refusal(
        `# 身份\n头衔：${field === "头衔" ? text : "甲"}\n## 职责\n${field === "职责" ? text : ""}\n# 人设\n## 工作守则\n${field === "工作守则" ? text : ""}\n# 手册\n${field === "手册" ? text : ""}`,
      );
    expect(tooLong("头衔", "题".repeat(81))).toMatchObject({
      section: "头衔",
      message: "「头衔」不能超过 80 字。",
    });
    expect(tooLong("职责", "职".repeat(501)).section).toBe("职责");
    expect(tooLong("工作守则", "则".repeat(2001)).section).toBe("工作守则");
    expect(tooLong("手册", "册".repeat(8001))).toMatchObject({
      section: "手册",
      message: "「手册」不能超过 8000 字。",
    });
  });

  test("an empty file", () => {
    expect(refusal("")).toMatchObject({ section: "身份" });
  });
});

describe("validation of a profile from a request or a model", () => {
  test("trims, fills what is missing and refuses what is not text", () => {
    expect(validateRoleProfile({ identity: { title: "  甲 " } })).toEqual({
      ok: true,
      profile: {
        ...emptyRoleProfile(),
        identity: { title: "甲", roleDescription: "" },
      },
    });
    expect(validateRoleProfile([])).toMatchObject({ ok: false });
    expect(validateRoleProfile({ persona: { tone: 3 } })).toMatchObject({
      ok: false,
      section: "性格语气",
    });
    expect(
      validateRoleProfile({ identity: { title: "一\n二" } }),
    ).toMatchObject({ ok: false, section: "头衔" });
    expect(validateRoleProfile({ identity: "x" })).toMatchObject({
      ok: false,
      section: "身份",
    });
  });
});
