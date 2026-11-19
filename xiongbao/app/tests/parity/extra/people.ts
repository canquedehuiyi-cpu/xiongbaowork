import { type FixtureRoute, list, ok } from "../fixture-kit";

/**
 * Extra parity fixtures for the people area (see tests/parity/fixture-kit.ts): the reads the
 * employee detail, assembly, 角色模板 and 团队 Bot screens make that fixtures.ts does not answer.
 * Shapes follow the app's own readers (src/lib/roles, src/lib/team-bots, src/lib/knowledge,
 * src/lib/personas, src/lib/plugins).
 */

const AT = "2026-11-02T09:00:00.000Z";

const persona = (tone: string, principles: string, habits: string) => ({
  tone,
  principles,
  habits,
});

const ROLE_TEMPLATES = [
  {
    id: "role-weekly-analyst",
    name: "经营周报分析师",
    version: 3,
    updatedAt: AT,
    official: false as const,
    profile: {
      identity: {
        title: "整理每周经营数据",
        roleDescription: "汇总销售、库存与客服数据，每周一早上发出经营周报。",
      },
      persona: persona(
        "简洁、用数字说话",
        "先给结论，再给依据",
        "每份报表附上数据口径",
      ),
      bible: "## 数据口径\n\n- 销售额按签收日统计\n- 库存按每日 24:00 快照",
    },
  },
  {
    id: "role-support-lead",
    name: "售后客服组长",
    version: 1,
    updatedAt: AT,
    official: false as const,
    profile: {
      identity: {
        title: "处理售前售后咨询",
        roleDescription: "回答订单、物流和退换货问题，遇到投诉转给人工。",
      },
      persona: persona("耐心、口语化", "先安抚情绪再给方案", "不承诺赔偿金额"),
      bible: "",
    },
  },
];

const OFFICIAL_TEMPLATES = [
  {
    id: "official-code-reviewer",
    name: "代码审核员",
    version: 1 as const,
    official: true as const,
    profile: {
      identity: {
        title: "代码审核员",
        roleDescription: "审查差异、边界条件和测试覆盖。",
      },
      persona: persona("直接、具体", "只评论能复现的问题", "每条意见给出位置"),
      bible: "",
    },
  },
  {
    id: "official-ops",
    name: "运营助手",
    version: 1 as const,
    official: true as const,
    profile: {
      identity: {
        title: "运营助手",
        roleDescription: "整理运营数据、跟进进度并汇总结论。",
      },
      persona: persona("条理清楚", "按优先级排列待办", "结论放在第一行"),
      bible: "",
    },
  },
];

const TEAM_BOTS = [
  {
    id: "agent-research",
    name: "行业研究员",
    title: "每天整理行业新闻与竞品动态",
    roleDescription: "每天整理行业新闻与竞品动态。",
    mine: false,
    audience: "team" as const,
    publishedAt: AT,
    assigned: true,
    visibleToTeam: true,
    assignments: ["*"],
  },
  {
    id: "agent-auditor",
    name: "合规审核员",
    title: "检查合同与对外文案",
    roleDescription: "检查合同条款与对外文案的合规风险。",
    mine: false,
    audience: "people" as const,
    publishedAt: AT,
    assigned: false,
    visibleToTeam: true,
    assignments: [],
  },
  {
    id: "agent-analyst",
    name: "数据分析员",
    title: "整理每周经营数据",
    roleDescription: "汇总销售、库存与客服数据，每周一早上发出经营周报。",
    mine: true,
    audience: "people" as const,
    publishedAt: AT,
    assigned: false,
    visibleToTeam: true,
    people: ["li.na@example.com"],
    groups: ["运营部"],
    assignments: ["运营部"],
  },
];

export const EXTRA: FixtureRoute[] = [
  [
    "GET",
    /^\/api\/role-templates$/,
    (c) =>
      ok({
        templates: list(c, ROLE_TEMPLATES),
        official: list(c, OFFICIAL_TEMPLATES),
      }),
  ],
  [
    "GET",
    /^\/api\/role-templates\/models$/,
    () =>
      ok({
        models: [
          {
            id: "model-deepseek",
            name: "DeepSeek 通用",
            label: "DeepSeek 通用 · DeepSeek",
          },
        ],
      }),
  ],
  [
    "GET",
    /^\/api\/role-templates\/employees\/([^/]+)$/,
    () => ok({ acceptsRoleTemplate: true, source: null }),
  ],
  [
    "GET",
    /^\/api\/team-bots$/,
    (c) =>
      ok({
        teamBots: list(c, TEAM_BOTS),
        publishable: list(c, [
          { id: "agent-writer", name: "文案助理", title: "撰写营销文案" },
        ]),
      }),
  ],
  [
    "GET",
    /^\/api\/knowledge\/for\/([^/]+)$/,
    (c) =>
      ok({
        notebooks: list(c, [
          {
            notebookId: "notebook-products",
            title: "产品手册",
            accessMode: "read",
          },
        ]),
      }),
  ],
  [
    "GET",
    /^\/api\/personas$/,
    (c) =>
      ok({
        templates: list(c, [
          {
            id: "persona-concise",
            name: "简洁汇报",
            persona: persona("简洁、用数字说话", "先给结论", "不用感叹号"),
            updatedAt: AT,
          },
        ]),
      }),
  ],
  [
    "GET",
    /^\/api\/plugins\/for\/([^/]+)\/installed-by-me$/,
    () => ok({ tools: [], skills: [] }),
  ],
];
