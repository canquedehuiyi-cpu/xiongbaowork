import type {
  GithubBindingRecord,
  ResponsibilityRunRecord,
  TriggerRecord,
} from "@/lib/responsibilities";
import type { PipelineRun, PipelineTemplate } from "@/lib/pipelines/queries";
import type {
  WakerFlowConfirmation,
  WakerFlowRun,
  WakerFlowRunEvent,
  WakerFlowShare,
  WakerFlowSharePreview,
} from "@/lib/wakerflows";
import { type FixtureRoute, list, ok } from "../fixture-kit";

/**
 * Extra parity fixtures for the workflows area (see tests/parity/fixture-kit.ts): 组团流程's
 * templates and one run, 长期职责's triggers and GitHub sources, and WakerFlow's run detail, run
 * events, share links and a share preview for `/wakerflows/import/<token>`.
 *
 * Ids match fixtures.ts: group-ops (agent-analyst, agent-support, agent-writer), the Flow
 * flow-weekly with its runs run-01 (done) and run-02 (failed), duty-01 and duty-02.
 */

/** The same clock fixtures.ts reads its relative times from. */
const BASE = Date.parse("2026-11-01T09:00:00.000Z");
const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();

const TEMPLATES: PipelineTemplate[] = [
  {
    id: "pipeline-weekly",
    groupId: "group-ops",
    name: "周报出稿",
    steps: [
      {
        id: "s1",
        agentId: "agent-analyst",
        instruction: "汇总本周销售、库存与退款数据，列出三条关键变化。",
      },
      {
        id: "s2",
        agentId: "agent-writer",
        instruction: "根据上一步的数据写成一页周报，语气平实。",
      },
      {
        id: "s3",
        agentId: "agent-support",
        instruction: "补充本周客诉要点，并核对周报里的售后数字。",
      },
    ],
    createdAt: at(30),
  },
  {
    id: "pipeline-refund",
    groupId: "group-ops",
    name: "退款异常复核",
    steps: [
      {
        id: "s1",
        agentId: "agent-support",
        instruction: "整理昨日超过 500 元的退款单与客户说明。",
      },
      {
        id: "s2",
        agentId: "agent-analyst",
        instruction: "对照财务流水标出不一致的单号。",
      },
    ],
    createdAt: at(52),
  },
];

const PIPELINE_RUN: PipelineRun = {
  status: "running",
  cursor: 1,
  parentTaskId: "task-05",
  steps: [
    {
      ...TEMPLATES[0]!.steps[0]!,
      state: "done",
      output: "本周销售额环比 +6%，库存周转 18 天，退款率 1.2%。",
    },
    { ...TEMPLATES[0]!.steps[1]!, state: "running" },
    { ...TEMPLATES[0]!.steps[2]!, state: "pending" },
  ],
};

const TRIGGERS: Record<string, TriggerRecord[]> = {
  "duty-01": [
    {
      id: "trigger-01",
      responsibilityId: "duty-01",
      kind: "webhook",
      config: { kind: "webhook", filter: { eventTypes: ["refund.created"] } },
      hasSecret: true,
      enabled: true,
      path: "/hooks/responsibilities/trigger-01",
      address: null,
      createdAt: at(60),
    },
  ],
  "duty-02": [
    {
      id: "trigger-02",
      responsibilityId: "duty-02",
      kind: "github",
      config: {
        kind: "github",
        repository: "xiongbao/order-service",
        filter: { eventTypes: ["issues"] },
      },
      hasSecret: true,
      enabled: false,
      path: "/hooks/responsibilities/trigger-02",
      address: null,
      createdAt: at(70),
    },
  ],
};

const BINDINGS: GithubBindingRecord[] = [
  {
    id: "binding-01",
    source: "github",
    repository: "xiongbao/order-service",
    createdAt: at(40),
    webhookPath: "/hooks/github/binding-01",
  },
];

const DUTY_RUNS: Record<string, ResponsibilityRunRecord[]> = {
  "duty-01": [
    {
      id: "duty-run-01",
      status: "succeeded",
      replyText: "十月退款流水与财务记录一致，无差异。",
      error: null,
      waiting: null,
      startedAt: at(79.9),
      finishedAt: at(80),
      createdAt: at(79.9),
    },
  ],
  "duty-02": [
    {
      id: "duty-run-02",
      status: "failed",
      replyText: null,
      error: "订单服务监控接口超时。",
      waiting: null,
      startedAt: at(136),
      finishedAt: at(136.1),
      createdAt: at(136),
    },
  ],
};

const FLOW_STEPS = [
  {
    id: "numbers",
    agentId: "agent-analyst",
    instruction: "汇总本周关键数据",
    inputKeys: ["week"],
    outputKey: "numbers",
  },
  {
    id: "report",
    agentId: "agent-writer",
    instruction: "根据数据写成周报",
    inputKeys: ["numbers", "focus"],
    outputKey: "report",
  },
] as const;

const RUNS: Record<string, WakerFlowRun> = {
  "run-01": {
    id: "run-01",
    flowId: "flow-weekly",
    status: "done",
    cursor: 2,
    parentTaskId: "task-08",
    inputs: { week: "第 44 周" },
    steps: [
      {
        ...FLOW_STEPS[0],
        inputKeys: [...FLOW_STEPS[0].inputKeys],
        state: "done",
        output: "销售额环比 +6%；退款率 1.2%；库存周转 18 天。",
      },
      {
        ...FLOW_STEPS[1],
        inputKeys: [...FLOW_STEPS[1].inputKeys],
        state: "done",
        output: "第 44 周工作周报：整体平稳，退款略升，下周跟进华东仓补货。",
      },
    ],
  },
  "run-02": {
    id: "run-02",
    flowId: "flow-weekly",
    status: "failed",
    cursor: 1,
    parentTaskId: null,
    inputs: { week: "第 45 周" },
    steps: [
      {
        ...FLOW_STEPS[0],
        inputKeys: [...FLOW_STEPS[0].inputKeys],
        state: "done",
        output: "销售额环比 -2%；退款率 1.4%。",
      },
      {
        ...FLOW_STEPS[1],
        inputKeys: [...FLOW_STEPS[1].inputKeys],
        state: "failed",
        error: "文案助理已暂停，这一步没能开始。",
      },
    ],
  },
};

const EVENTS: Record<string, WakerFlowRunEvent[]> = {
  "run-01": [
    { type: "run_started", payload: { cursor: 0 }, hours: 117 },
    { type: "step_started", payload: { index: 0 }, hours: 117.01 },
    { type: "step_done", payload: { index: 0 }, hours: 117.1 },
    { type: "step_started", payload: { index: 1 }, hours: 117.11 },
    { type: "step_done", payload: { index: 1 }, hours: 117.3 },
    { type: "run_done", payload: {}, hours: 117.31 },
  ].map((event, index) => ({
    sequence: index + 1,
    type: event.type,
    correlationId: "run-01",
    payload: event.payload,
    createdAt: at(event.hours),
  })),
  "run-02": [
    { type: "run_started", payload: { cursor: 0 }, hours: 94 },
    { type: "step_started", payload: { index: 0 }, hours: 94.01 },
    { type: "step_done", payload: { index: 0 }, hours: 94.12 },
    {
      type: "step_failed",
      payload: { index: 1, error: "文案助理已暂停" },
      hours: 94.13,
    },
  ].map((event, index) => ({
    sequence: index + 1,
    type: event.type,
    correlationId: "run-02",
    payload: event.payload,
    createdAt: at(event.hours),
  })),
};

const CONFIRMATIONS: WakerFlowConfirmation[] = [];

const SHARES: WakerFlowShare[] = [
  {
    id: "share-01",
    flowId: "flow-weekly",
    status: "active",
    expiresAt: at(260),
    maxUses: 10,
    uses: 2,
    remainingUses: 8,
    revokedAt: null,
    createdAt: at(92),
  },
  {
    id: "share-02",
    flowId: "flow-weekly",
    status: "revoked",
    expiresAt: at(180),
    maxUses: 5,
    uses: 1,
    remainingUses: 0,
    revokedAt: at(60),
    createdAt: at(12),
  },
];

const SHARE_PREVIEW: WakerFlowSharePreview = {
  name: "会议纪要流程",
  description: "整理结论、待办和负责人，会后半小时内发出。",
  slots: [
    { slot: "recorder", role: "记录员", prompt: "你负责记录发言要点与结论。" },
    { slot: "editor", role: "整理人", prompt: "你负责把要点整理成纪要。" },
  ],
  inputCount: 1,
  stepCount: 3,
  expiresAt: at(250),
  remainingUses: 3,
};

export const EXTRA: FixtureRoute[] = [
  // 组团流程
  [
    "GET",
    /^\/api\/group-pipelines\/templates$/,
    (c) => {
      const group = c.params.get("groupId");
      return ok({
        templates: list(c, TEMPLATES).filter(
          (template) => !group || template.groupId === group,
        ),
      });
    },
  ],
  [
    "GET",
    /^\/api\/group-pipelines\/runs\/([^/]+)$/,
    (c) => (c.data ? ok({ run: PIPELINE_RUN }) : undefined),
  ],

  // 长期职责
  [
    "GET",
    /^\/api\/responsibilities\/sources\/github$/,
    (c) => ok({ bindings: list(c, BINDINGS) }),
  ],
  [
    "GET",
    /^\/api\/responsibilities\/([^/]+)\/triggers$/,
    (c) =>
      ok({
        triggers: list(c, TRIGGERS[decodeURIComponent(c.match[1]!)] ?? []),
      }),
  ],
  [
    "GET",
    /^\/api\/responsibilities\/([^/]+)\/runs$/,
    (c) =>
      ok({ runs: list(c, DUTY_RUNS[decodeURIComponent(c.match[1]!)] ?? []) }),
  ],

  // WakerFlow: one run, its events and questions, the Flow's share links
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/runs\/([^/]+)\/events$/,
    (c) => {
      const after = Number(c.params.get("after") ?? 0);
      const events = (EVENTS[decodeURIComponent(c.match[2]!)] ?? []).filter(
        (event) => event.sequence > after,
      );
      return ok({ events: list(c, events), next: null });
    },
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/runs\/([^/]+)\/confirmations$/,
    (c) => ok({ confirmations: list(c, CONFIRMATIONS) }),
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/runs\/([^/]+)$/,
    (c) => {
      const run = RUNS[decodeURIComponent(c.match[2]!)];
      return c.data && run
        ? ok({ run })
        : { status: 404, body: { error: "这次运行没能加载。" } };
    },
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/shares$/,
    (c) => ok({ shares: list(c, SHARES) }),
  ],
  [
    "GET",
    /^\/api\/wakerflow-shares\/([^/]+)$/,
    (c) =>
      c.data
        ? ok({ share: SHARE_PREVIEW })
        : { status: 410, body: { error: "这个分享链接已过期。" } },
  ],
];
