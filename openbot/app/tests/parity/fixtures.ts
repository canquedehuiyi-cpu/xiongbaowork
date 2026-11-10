/**
 * 视觉对照（parity）截图用的合成数据集。
 *
 * The browser harness (`capture.ts`) intercepts every `/api/**` request and answers it from here, so
 * the dev server needs no backend. Every body below is typed against the app's own types (imported
 * type-only from `@/lib/...`), which is what makes `bun run --cwd app typecheck` the check that this
 * dataset still matches what the screens read.
 *
 * All names, emails and machines are synthetic. Timestamps are fixed (anchored on 2026-11-01) and
 * ids are deterministic, so two captures of the same scenario produce the same pixels.
 */

import { EventType, type Message } from "@ag-ui/core";
import type { AgentProfile } from "@/lib/agents/queries";
import type {
  ApprovalInboxData,
  ApprovalRequestData,
  EmployeePermissions,
} from "@/lib/approvals";
import type { AuthenticatedUser } from "@/lib/auth/queries";
import type { Automation, AutomationTrigger } from "@/lib/automations/queries";
import type { AutonomousSummary } from "@/lib/autonomous/queries";
import type { AvatarSourceState } from "@/lib/avatar/sources";
import type {
  ActivityItem,
  AgentRunningTask,
  BotActivity,
  BotAttention,
  BotLifecycle,
  UpdateRouting,
} from "@/lib/bot-lifecycle/queries";
import type {
  AgentChannel,
  ChannelPage,
  ChannelSummary,
} from "@/lib/channels/queries";
import type {
  ComponentRecord,
  GrantedComponent,
} from "@/lib/components/queries";
import type { ControlState } from "@/lib/computers/control";
import type { Reachability } from "@/lib/delivery";
import type { DeploymentCapabilities } from "@/lib/deployment/queries";
import type { RegisteredDevice } from "@/lib/devices/queries";
import type {
  KnowledgeNotebook,
  KnowledgeNotebookDetail,
  KnowledgeSourceSummary,
} from "@/lib/knowledge/queries";
import type { MemorySource } from "@/lib/memory";
import type { ModelLibrary } from "@/lib/models/queries";
import type {
  GrantedPlugins,
  InstallListing,
  PluginConnections,
  PluginServer,
  PluginSkill,
  PluginsPage,
} from "@/lib/plugins/queries";
import type { ProjectList } from "@/lib/projects/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutinesPage } from "@/lib/routines/queries";
import type { PublishedSandboxed } from "@/lib/sandboxed/queries";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import type {
  FlowModelChoice,
  WakerFlow,
  WakerFlowRunSummary,
  WakerFlowSession,
  WakerFlowSessionTurn,
  WakerFlowVersionSummary,
} from "@/lib/wakerflows";
import type { OpenTarget } from "@/routes/_authed/_app/tasks";
import type { UserPreferences } from "../../../shared/user-preferences";
import { EXTRA as ADMIN_EXTRA } from "./extra/admin";
import { EXTRA as CONVERSATION_EXTRA } from "./extra/conversations";
import { EXTRA as PEOPLE_EXTRA } from "./extra/people";
import { EXTRA as WORKFLOW_EXTRA } from "./extra/workflows";

export type Scenario = "data" | "empty";
export const SCENARIOS: readonly Scenario[] = ["data", "empty"];

/**
 * One answer. `body` is sent as JSON unless `contentType` is given, in which case it must be the raw
 * string to send (used for CopilotKit's server-sent event stream).
 */
export type FixtureResponse = {
  status: number;
  body: unknown;
  contentType?: string;
};

/* ------------------------------------------------------------------------------------------------ */
/* Time                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/** Every timestamp is an offset from this instant, so the dataset never drifts with the wall clock. */
const BASE = Date.parse("2026-11-01T09:00:00.000Z");
/** `at(h)` = BASE + h hours, as ISO. The capture freezes the page clock at 2026-11-07T02:00Z (h=137). */
const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();

/* ------------------------------------------------------------------------------------------------ */
/* People and coworkers                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export const USER: AuthenticatedUser = {
  id: "user-demo",
  email: "demo@example.com",
  name: "演示用户",
  image: null,
  role: "admin",
  onboarding: null,
};

const agentBase: AgentProfile = {
  id: "",
  name: "",
  title: "",
  roleDescription: "",
  avatarSeed: "",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  platformModelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  assignedToMe: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
};

const agent = (over: Partial<AgentProfile> & Pick<AgentProfile, "id">) => ({
  ...agentBase,
  avatarSeed: over.id,
  ...over,
});

/** The active roster (`GET /api/agents`). */
const AGENTS: AgentProfile[] = [
  agent({
    id: "agent-analyst",
    name: "数据分析员",
    title: "整理每周经营数据",
    roleDescription: "汇总销售、库存与客服数据，每周一早上发出经营周报。",
    pinned: true,
    modelRef: "model-deepseek",
    persona: {
      tone: "简洁、用数字说话",
      principles: "先给结论，再给依据",
      habits: "每份报表附上数据口径",
    },
  }),
  agent({
    id: "agent-support",
    name: "客服小熊",
    title: "回复客户咨询",
    roleDescription: "处理售前售后咨询，遇到退款与投诉时转交人工确认。",
    hasCallbackToken: true,
  }),
  agent({
    id: "agent-writer",
    name: "文案助理",
    title: "撰写营销文案",
    roleDescription: "根据活动简报撰写公众号推文、海报文案与短信。",
  }),
  agent({
    id: "agent-ops",
    name: "运维巡检员",
    title: "巡检服务器与告警",
    roleDescription: "每小时巡检线上服务，发现异常时汇报并给出处置建议。",
    endpoint: "https://bots.example.com/ops",
    builtIn: false,
    hasAuth: true,
  }),
  agent({
    id: "agent-research",
    name: "行业研究员",
    title: "跟踪行业动态",
    roleDescription: "每天整理行业新闻与竞品动向，形成简报。",
    visibility: "public",
    mine: false,
    canManage: true,
  }),
  // The person's own 分身 (`AVATAR_SOURCES.agentId`), as docs/design/ios-studio shows it on the roster.
  agent({
    id: "agent-avatar",
    name: "我的分身",
    title: "个人分身",
    roleDescription: "收集、整理和跟进与你有关的工作。",
  }),
];

/** The switched-off coworkers (`GET /api/agents?hidden=true`). */
const HIDDEN_AGENTS: AgentProfile[] = [
  agent({
    id: "agent-auditor",
    name: "夜间审计员",
    title: "核对夜间账务",
    roleDescription: "每晚核对当天的订单与退款流水。",
    hidden: true,
  }),
];

const ALL_AGENTS = [...AGENTS, ...HIDDEN_AGENTS];

const GROUPS: WakerGroup[] = [
  {
    id: "group-ops",
    name: "运营群组",
    description: "负责日常运营：数据、客服与文案。",
    members: [
      { agentId: "agent-analyst", position: 0 },
      { agentId: "agent-support", position: 1 },
      { agentId: "agent-writer", position: 2 },
    ],
  },
  {
    id: "group-research",
    name: "研究群组",
    description: null,
    members: [
      { agentId: "agent-research", position: 0 },
      { agentId: "agent-ops", position: 1 },
    ],
  },
];

const ATTENTION: BotAttention[] = [
  {
    agentId: "agent-analyst",
    name: "数据分析员",
    questions: 1,
    approvals: 0,
    handoffs: 0,
    unread: 2,
    paused: false,
    notify: "all",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
  },
  {
    agentId: "agent-support",
    name: "客服小熊",
    questions: 0,
    approvals: 2,
    handoffs: 1,
    unread: 0,
    paused: false,
    notify: "needs_input",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
  },
  {
    agentId: "agent-writer",
    name: "文案助理",
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: true,
    notify: "none",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
  },
];

/* ------------------------------------------------------------------------------------------------ */
/* Machines                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const DEVICES: RegisteredDevice[] = [
  {
    id: "device-row-1",
    deviceId: "device-laptop",
    name: "演示笔记本",
    platform: "macos",
    lastSeenAt: at(136.9),
    online: true,
    queued: 1,
    uncertain: 0,
    needsAttention: false,
    roots: [{ ref: "root-docs", name: "项目文档" }],
  },
  {
    id: "device-row-2",
    deviceId: "device-desktop",
    name: "办公室台式机",
    platform: "windows",
    lastSeenAt: at(110),
    online: false,
    queued: 0,
    uncertain: 1,
    needsAttention: true,
    roots: [],
  },
];

/* ------------------------------------------------------------------------------------------------ */
/* Tasks                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The board's row. `Task` itself is private to `routes/_authed/_app/tasks.tsx`; this is that shape,
 * built on the exported pieces (`AgentRunningTask`, `OpenTarget`) so drift in them still fails here.
 */
export type BoardTask = AgentRunningTask & {
  triggerSource?: string | null;
  channelRef: string | null;
  open?: OpenTarget | null;
  deliverableRef: unknown;
  model: string | null;
  deviceId: string | null;
  archivedAt?: string | null;
  pendingApprovalId?: string | null;
};

const task = (
  over: Partial<BoardTask> &
    Pick<BoardTask, "id" | "title" | "status" | "source" | "updatedAt">,
): BoardTask => ({
  executorAgentId: null,
  triggerSource: null,
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  deviceId: null,
  archivedAt: null,
  pendingApprovalId: null,
  ...over,
});

const TASKS: BoardTask[] = [
  // 进行中
  task({
    id: "task-01",
    title: "汇总十月第五周销售数据",
    status: "running",
    source: "routine",
    triggerSource: "routine",
    executorAgentId: "agent-analyst",
    channelRef: "thread-analyst",
    open: { kind: "channel", id: "channel-analyst" },
    model: "deepseek-chat",
    deviceId: "device-laptop",
    updatedAt: at(136.5),
  }),
  task({
    id: "task-02",
    title: "回复客户关于发货时间的咨询",
    status: "running",
    source: "chat",
    executorAgentId: "agent-support",
    channelRef: "thread-support",
    open: { kind: "channel", id: "channel-support" },
    model: "glm-4-plus",
    updatedAt: at(136.8),
  }),
  task({
    id: "task-03",
    title: "巡检订单服务响应时间",
    status: "running",
    source: "responsibility",
    triggerSource: "proactive",
    executorAgentId: "agent-ops",
    model: "deepseek-chat",
    updatedAt: at(136.2),
  }),
  // 需要操作
  task({
    id: "task-04",
    title: "批准向客户发放 50 元优惠券",
    status: "needs_action",
    source: "chat",
    executorAgentId: "agent-support",
    channelRef: "thread-support",
    open: { kind: "channel", id: "channel-support" },
    pendingApprovalId: "approval-01",
    updatedAt: at(135.5),
  }),
  task({
    id: "task-05",
    title: "确认双十一活动推文的发布时间",
    status: "needs_action",
    source: "handoff",
    executorAgentId: "agent-writer",
    open: { kind: "group", id: "group-ops" },
    updatedAt: at(134),
  }),
  task({
    id: "task-06",
    title: "同步竞品价格变动",
    status: "failed",
    source: "routine",
    triggerSource: "automation:schedule",
    executorAgentId: "agent-research",
    deliverableRef: {
      kind: "circuit_breaker",
      failures: 10,
      routineId: "routine-07",
      automationId: "automation-02",
    },
    updatedAt: at(130),
  }),
  // 待查收
  task({
    id: "task-07",
    title: "十月经营周报",
    status: "awaiting_review",
    source: "routine",
    triggerSource: "routine",
    executorAgentId: "agent-analyst",
    open: { kind: "channel", id: "channel-analyst" },
    deliverableRef: {
      kind: "deliverable",
      components: [{ name: "weekly-report" }],
      attachments: [{ name: "周报.xlsx" }],
    },
    model: "deepseek-chat",
    updatedAt: at(120),
  }),
  task({
    id: "task-08",
    title: "整理本周行业新闻简报",
    status: "awaiting_review",
    source: "group_run",
    executorAgentId: "agent-research",
    open: { kind: "wakerflow", id: "flow-weekly" },
    updatedAt: at(118),
  }),
  // 已结束
  task({
    id: "task-09",
    title: "撰写会员日短信文案",
    status: "done",
    source: "chat",
    executorAgentId: "agent-writer",
    channelRef: "thread-writer",
    open: { kind: "channel", id: "channel-writer" },
    model: "glm-4-plus",
    updatedAt: at(100),
  }),
  task({
    id: "task-10",
    title: "核对十月退款流水",
    status: "done",
    source: "responsibility",
    triggerSource: "responsibility",
    executorAgentId: "agent-analyst",
    deviceId: "device-desktop",
    updatedAt: at(80),
  }),
  task({
    id: "task-11",
    title: "唤醒跟进：未回复的售后工单",
    status: "done",
    source: "routine",
    triggerSource: "wake_up",
    executorAgentId: "agent-support",
    updatedAt: at(60),
  }),
  task({
    id: "task-12",
    title: "重启缓存服务",
    status: "failed",
    source: "chat",
    executorAgentId: "agent-ops",
    archivedAt: at(50),
    updatedAt: at(48),
  }),
];

/** Which `source=` values a trigger key expands to is the page's business; here a list just filters. */
function filterTasks(params: URLSearchParams): BoardTask[] {
  const status = params.get("status");
  const executor = params.get("executor");
  const executors = params.get("executors")?.split(",").filter(Boolean);
  const group = params.get("group");
  const sources = params.get("source")?.split(",").filter(Boolean);
  const deviceId = params.get("deviceId");
  const q = params.get("q")?.trim();
  const groupMembers = group
    ? new Set(
        GROUPS.find((entry) => entry.id === group)?.members.map(
          (member) => member.agentId,
        ) ?? [],
      )
    : undefined;
  return TASKS.filter(
    (row) =>
      (!status || row.status === status) &&
      (!executor || row.executorAgentId === executor) &&
      (!executors ||
        (row.executorAgentId !== null &&
          executors.includes(row.executorAgentId))) &&
      (!groupMembers ||
        (row.executorAgentId !== null &&
          groupMembers.has(row.executorAgentId))) &&
      (!sources || sources.includes(row.source)) &&
      (!deviceId || row.deviceId === deviceId) &&
      (!q || row.title.includes(q)),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Conversations                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

const CHANNELS: ChannelSummary[] = [
  {
    id: "channel-analyst",
    name: "经营周报",
    agentIds: ["agent-analyst"],
    threadId: "thread-analyst",
    active: true,
    lastMessageAt: at(136.5),
    summary: "十月第五周数据汇总中",
    lastMessage: "销售数据已汇总完毕，正在生成图表。",
    lastMessageAgentId: "agent-analyst",
    createdAt: at(0),
    pinned: true,
    lastReadAt: at(130),
    busy: true,
  },
  {
    id: "channel-support",
    name: "客户咨询",
    agentIds: ["agent-support"],
    threadId: "thread-support",
    active: true,
    lastMessageAt: at(136.8),
    summary: null,
    lastMessage: "已为您查询，订单预计明天发货。",
    lastMessageAgentId: "agent-support",
    createdAt: at(10),
    pinned: false,
    lastReadAt: at(136.8),
  },
  {
    id: "channel-writer",
    name: "会员日文案",
    agentIds: ["agent-writer"],
    threadId: "thread-writer",
    active: true,
    lastMessageAt: at(100),
    summary: "三版短信文案已完成",
    lastMessage: "三版文案都放在下面了，请挑选。",
    lastMessageAgentId: "agent-writer",
    createdAt: at(90),
    pinned: false,
    lastReadAt: at(100),
  },
  {
    id: "channel-team",
    name: "双十一筹备",
    agentIds: ["agent-analyst", "agent-writer", "agent-support"],
    threadId: "thread-team",
    active: true,
    lastMessageAt: at(134),
    summary: "活动节奏与分工讨论",
    lastMessage: "推文发布时间需要你确认一下。",
    lastMessageAgentId: "agent-writer",
    createdAt: at(20),
    pinned: false,
    lastReadAt: at(120),
  },
];

const channelOf = (summary: ChannelSummary): AgentChannel => ({
  id: summary.id,
  name: summary.name,
  agentIds: summary.agentIds,
  threadId: summary.threadId,
  active: summary.active,
  lastMessageAt: summary.lastMessageAt,
});

/* ------------------------------------------------------------------------------------------------ */
/* Resources: plugins, skills, models, knowledge, memory                                            */
/* ------------------------------------------------------------------------------------------------ */

const PLUGIN_SERVERS: PluginServer[] = [
  {
    id: "team:feishu",
    title: "飞书文档",
    logo: null,
    vendor: "示例供应商",
    url: "https://mcp.example.com/feishu",
    summary: "读取与编辑飞书云文档、表格。",
    docsUrl: "https://docs.example.com/feishu",
    provenance: "catalogue",
    hasCredential: true,
    toolsRefreshedAt: at(100),
    lastError: null,
    addedBy: "user-demo",
    dynamicClient: false,
    adminConnectOnly: false,
    authScheme: "bearer",
    tools: [
      {
        serverId: "team:feishu",
        name: "read_doc",
        description: "读取一篇云文档的正文。",
        inputSchema: { type: "object" },
        ref: "feishu/read_doc",
        effect: "read",
        destructive: false,
        grantedTo: ["agent-analyst", "agent-writer"],
      },
      {
        serverId: "team:feishu",
        name: "update_sheet",
        description: "更新表格中的单元格。",
        inputSchema: { type: "object" },
        ref: "feishu/update_sheet",
        effect: "write",
        destructive: false,
        grantedTo: ["agent-analyst"],
      },
    ],
    withdrawn: [],
  },
  {
    id: "team:crm",
    title: "客户管理系统",
    logo: null,
    vendor: "示例供应商",
    url: "https://mcp.example.com/crm",
    summary: "查询客户档案与订单记录。",
    docsUrl: "https://docs.example.com/crm",
    provenance: "custom",
    hasCredential: true,
    toolsRefreshedAt: at(90),
    lastError: null,
    addedBy: "user-demo",
    dynamicClient: false,
    adminConnectOnly: false,
    authScheme: "bearer",
    tools: [
      {
        serverId: "team:crm",
        name: "find_order",
        description: "按订单号查询订单。",
        inputSchema: { type: "object" },
        ref: "crm/find_order",
        effect: "read",
        destructive: false,
        grantedTo: ["agent-support"],
      },
      {
        serverId: "team:crm",
        name: "refund_order",
        description: "为订单发起退款。",
        inputSchema: { type: "object" },
        ref: "crm/refund_order",
        effect: "write",
        destructive: true,
        grantedTo: [],
      },
    ],
    withdrawn: [],
  },
  {
    id: "team:monitor",
    title: "监控告警",
    logo: null,
    vendor: "示例供应商",
    url: "https://mcp.example.com/monitor",
    summary: "读取服务指标与告警事件。",
    docsUrl: "https://docs.example.com/monitor",
    provenance: "catalogue",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: "凭据已过期，请重新连接。",
    addedBy: null,
    dynamicClient: false,
    adminConnectOnly: false,
    authScheme: null,
    tools: [],
    withdrawn: [],
  },
];

const SKILLS: PluginSkill[] = [
  {
    id: "skill-01",
    slug: "weekly-report",
    ownerUserId: null,
    title: "经营周报",
    summary: "按固定模板汇总一周经营数据。",
    instructions: "1. 读取销售表\n2. 计算环比\n3. 输出周报",
    origin: "workspace",
    installedBy: "user-demo",
    grantedTo: ["agent-analyst"],
    tools: ["feishu/read_doc"],
  },
  {
    id: "skill-02",
    slug: "after-sales",
    ownerUserId: null,
    title: "售后话术",
    summary: "退换货、物流与投诉场景的标准回复。",
    instructions: "先致歉，再给出处理时限。",
    origin: "workspace",
    installedBy: "user-demo",
    grantedTo: ["agent-support"],
    tools: [],
  },
  {
    id: "skill-03",
    slug: "copywriting",
    ownerUserId: "user-demo",
    title: "营销文案写作",
    summary: "公众号、短信、海报三种体裁的写作规范。",
    instructions: "标题不超过 20 字。",
    origin: "personal",
    installedBy: "user-demo",
    grantedTo: ["agent-writer"],
    tools: [],
  },
  {
    id: "skill-04",
    slug: "incident-triage",
    ownerUserId: null,
    title: "告警分级",
    summary: "按影响范围给告警分级并给出处置建议。",
    instructions: "P0 立即通知值班人。",
    origin: "workspace",
    installedBy: null,
    grantedTo: [],
    tools: [],
  },
];

const PLUGINS_PAGE: PluginsPage = {
  catalogue: [
    {
      key: "feishu",
      title: "飞书文档",
      vendor: "示例供应商",
      summary: "读取与编辑飞书云文档、表格。",
      docsUrl: "https://docs.example.com/feishu",
      auth: "deployment-bearer",
      perInstance: false,
    },
    {
      key: "monitor",
      title: "监控告警",
      vendor: "示例供应商",
      summary: "读取服务指标与告警事件。",
      docsUrl: "https://docs.example.com/monitor",
      auth: "user-oauth",
      perInstance: true,
    },
    {
      key: "calendar",
      title: "日程",
      vendor: "示例供应商",
      summary: "查看与安排日程。",
      docsUrl: "https://docs.example.com/calendar",
      auth: "none",
      perInstance: false,
    },
    // Three more market entries, so the 插件市场 grid fills the 3 × 2 the design draws.
    {
      key: "web-search",
      title: "联网搜索",
      vendor: "示例供应商",
      summary: "搜索公开网页并提取来源。",
      docsUrl: "https://docs.example.com/web-search",
      auth: "builtin",
      perInstance: false,
    },
    {
      key: "cloud-drive",
      title: "云盘文件",
      vendor: "示例供应商",
      summary: "读取提问者已授权的云盘文件。",
      docsUrl: "https://docs.example.com/cloud-drive",
      auth: "user-oauth",
      perInstance: false,
    },
    {
      key: "tickets",
      title: "工单系统",
      vendor: "示例供应商",
      summary: "查询与更新客服工单的处理进度。",
      docsUrl: "https://docs.example.com/tickets",
      auth: "deployment-bearer",
      perInstance: false,
    },
  ],
  servers: PLUGIN_SERVERS,
  skills: SKILLS,
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

const PLUGIN_CONNECTIONS: PluginConnections = {
  connections: [
    {
      serverId: "team:feishu",
      scope: "user",
      connectedAt: at(50),
      verified: true,
      verifiedAt: at(130),
      probe: null,
      checkable: true,
    },
  ],
  redirectUri: null,
};

const LISTINGS: InstallListing[] = [
  { kind: "mcp", ref: "feishu", listedAt: at(40), listedBy: "user-demo" },
  { kind: "skill", ref: "weekly-report", listedAt: at(41) },
];

const MODELS: ModelLibrary = {
  models: [
    {
      id: "model-deepseek",
      provider: "deepseek",
      baseUrl: null,
      modelName: "deepseek-chat",
      label: "DeepSeek 通用",
      enabled: true,
      updatedAt: at(30),
      coworkers: 1,
    },
    {
      id: "model-glm",
      provider: "zhipu",
      baseUrl: null,
      modelName: "glm-4-plus",
      label: null,
      enabled: true,
      updatedAt: at(31),
      coworkers: 0,
    },
  ],
  templates: [
    {
      id: "deepseek",
      label: "DeepSeek",
      allowsBaseUrl: false,
      probe: "chat",
    },
    { id: "zhipu", label: "智谱 GLM", allowsBaseUrl: false, probe: "chat" },
    {
      id: "custom",
      label: "自定义端点",
      allowsBaseUrl: true,
      probe: "chat",
    },
  ],
  pool: [
    {
      id: "pool-qwen",
      provider: "custom",
      modelName: "qwen-max",
      label: "通义千问 Max",
      coworkers: 2,
      available: true,
    },
  ],
  customModels: true,
};

const NOTEBOOKS: KnowledgeNotebook[] = [
  {
    id: "notebook-products",
    title: "产品手册",
    revision: 4,
    createdAt: at(2),
    updatedAt: at(120),
  },
  {
    id: "notebook-faq",
    title: "客服常见问题",
    revision: 9,
    createdAt: at(3),
    updatedAt: at(130),
  },
  {
    id: "notebook-brand",
    title: "品牌规范",
    revision: 1,
    createdAt: at(5),
    updatedAt: at(5),
  },
];

const NOTEBOOK_SOURCES: KnowledgeSourceSummary[] = [
  {
    id: "source-01",
    notebookId: "notebook-products",
    title: "2026 秋季新品介绍",
    kind: "markdown",
    digest: "秋季新品的卖点、价格与库存说明。",
    chars: 4200,
    revision: 2,
    updatedAt: at(110),
  },
  {
    id: "source-02",
    notebookId: "notebook-products",
    title: "保修政策",
    kind: "text",
    digest: null,
    chars: 1300,
    revision: 1,
    updatedAt: at(60),
  },
  {
    id: "source-03",
    notebookId: "notebook-faq",
    title: "物流与发货",
    kind: "markdown",
    digest: "发货时效、快递公司与查询方式。",
    chars: 2600,
    revision: 5,
    updatedAt: at(130),
  },
];

function notebookDetail(id: string): KnowledgeNotebookDetail | undefined {
  const notebook = NOTEBOOKS.find((entry) => entry.id === id);
  if (!notebook) return undefined;
  return {
    notebook,
    sources: NOTEBOOK_SOURCES.filter((source) => source.notebookId === id),
    bindings: [
      {
        agentId: "agent-support",
        notebookId: id,
        accessMode: "read",
        updatedAt: at(70),
      },
    ],
  };
}

const MEMORY_SOURCES: MemorySource[] = [
  {
    id: "memory-source-01",
    title: "飞书周会纪要",
    agentId: "agent-analyst",
    toolRef: "feishu/read_doc",
    enabled: true,
    syncStatus: "succeeded",
    syncError: null,
    lastSyncAt: at(130),
  },
  {
    id: "memory-source-02",
    title: "客户工单摘要",
    agentId: "agent-support",
    toolRef: "crm/find_order",
    enabled: false,
    syncStatus: "error",
    syncError: "连接超时",
    lastSyncAt: at(90),
  },
];

const AVATAR_SOURCES: AvatarSourceState = {
  agentId: "agent-avatar",
  configuredAt: at(20),
  sources: [
    {
      id: "avatar-source-01",
      kind: "declaration",
      label: "工作习惯",
      note: "每周一上午开周会，周五下午复盘。",
      createdAt: at(20),
    },
    {
      id: "avatar-source-02",
      kind: "notebook",
      label: "产品资料",
      note: "回答产品问题时优先参考。",
      notebookId: "notebook-products",
      title: "产品手册",
      createdAt: at(21),
    },
  ],
};

const COMPONENTS: ComponentRecord[] = [
  {
    name: "weekly-report",
    title: "经营周报卡片",
    kind: "card",
    draftDescription: "展示一周关键经营指标。",
    publishedDescription: "展示一周关键经营指标。",
    published: true,
    publishedAt: at(40),
    updatedBy: "user-demo",
    updatedAt: at(40),
    hasUnpublishedChanges: false,
    withheldFrom: [],
    functions: [],
  },
  {
    name: "order-status",
    title: "订单状态",
    kind: "card",
    draftDescription: "展示订单的物流进度。",
    publishedDescription: null,
    published: false,
    publishedAt: null,
    updatedBy: "user-demo",
    updatedAt: at(80),
    hasUnpublishedChanges: true,
    withheldFrom: ["agent-ops"],
    functions: [],
  },
];

/* ------------------------------------------------------------------------------------------------ */
/* Autonomous work, automations, WakerFlows                                                          */
/* ------------------------------------------------------------------------------------------------ */

const AUTONOMOUS: Record<string, AutonomousSummary> = {
  "agent-analyst": {
    agentId: "agent-analyst",
    routines: [
      {
        id: "routine-01",
        instruction: "每周一 09:00 汇总上周销售数据并发出经营周报",
        enabled: true,
        nextRunAt: at(144),
        channelId: "channel-analyst",
        lastRun: { status: "succeeded", at: at(120) },
      },
      {
        id: "routine-02",
        instruction: "每天 18:00 检查库存低于安全线的商品",
        enabled: false,
        nextRunAt: at(142),
        channelId: "channel-analyst",
        lastRun: { status: "failed", at: at(106) },
      },
    ],
    responsibilities: [
      {
        id: "duty-01",
        title: "月底核对退款流水",
        status: "active",
        channelId: "channel-analyst",
        lastRun: { status: "succeeded", at: at(80) },
      },
    ],
    proactive: [
      {
        id: "proactive-01",
        focus: "销售额异常波动",
        enabled: true,
        intervalMinutes: 240,
        nextRunAt: at(139),
        lastRunAt: at(135),
        lastStatus: "succeeded",
      },
    ],
    lastActivityAt: at(136.5),
  },
  "agent-support": {
    agentId: "agent-support",
    routines: [
      {
        id: "routine-03",
        instruction: "每天 10:00 跟进未回复超过 24 小时的工单",
        enabled: true,
        nextRunAt: at(138),
        channelId: "channel-support",
        lastRun: { status: "succeeded", at: at(114) },
      },
    ],
    responsibilities: [],
    proactive: [],
    lastActivityAt: at(136.8),
  },
  "agent-ops": {
    agentId: "agent-ops",
    routines: [],
    responsibilities: [
      {
        id: "duty-02",
        title: "每小时巡检订单服务",
        status: "active",
        channelId: "channel-team",
        lastRun: { status: "running", at: at(136.2) },
      },
    ],
    proactive: [
      {
        id: "proactive-02",
        focus: "错误率与响应时间",
        enabled: true,
        intervalMinutes: 60,
        nextRunAt: at(137.5),
        lastRunAt: at(136.2),
        lastStatus: "running",
      },
    ],
    lastActivityAt: at(136.2),
  },
};

const autonomousFor = (agentId: string): AutonomousSummary =>
  AUTONOMOUS[agentId] ?? {
    agentId,
    routines: [],
    responsibilities: [],
    proactive: [],
    lastActivityAt: null,
  };

const AUTOMATIONS: Automation[] = [
  {
    id: "automation-01",
    name: "每日行业简报",
    target: { kind: "waker", agentId: "agent-research" },
    enabled: true,
    maxRuns: null,
    endDate: null,
    runCount: 37,
    createdAt: at(1),
    breakerTripped: false,
  },
  {
    id: "automation-02",
    name: "竞品价格同步",
    target: { kind: "waker", agentId: "agent-research" },
    enabled: false,
    maxRuns: null,
    endDate: null,
    runCount: 12,
    createdAt: at(4),
    breakerTripped: true,
  },
  {
    id: "automation-03",
    name: "周报流程",
    target: { kind: "wakerflow", flowId: "flow-weekly" },
    enabled: true,
    maxRuns: 52,
    endDate: null,
    runCount: 9,
    createdAt: at(6),
    breakerTripped: false,
  },
];

/** Each automation's triggers, as `GET /api/automations/:id` answers them. */
const AUTOMATION_TRIGGERS: Record<string, AutomationTrigger[]> = {
  "automation-01": [
    {
      id: "trigger-01",
      automationId: "automation-01",
      config: {
        kind: "schedule",
        cron: "30 8 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      enabled: true,
      nextRunAt: at(150),
      hasSecret: false,
      lastError: null,
    },
  ],
  "automation-02": [
    {
      id: "trigger-02",
      automationId: "automation-02",
      config: { kind: "webhook" },
      enabled: false,
      nextRunAt: null,
      hasSecret: true,
      lastError: "连续 3 次执行失败，已熔断",
    },
  ],
  "automation-03": [
    {
      id: "trigger-03",
      automationId: "automation-03",
      config: {
        kind: "schedule",
        cron: "0 17 * * 5",
        timezone: "Asia/Shanghai",
      },
      enabled: true,
      nextRunAt: at(160),
      hasSecret: false,
      lastError: null,
    },
  ],
};

const FLOWS: WakerFlow[] = [
  {
    id: "flow-weekly",
    name: "工作周报流程",
    description: "汇总进展、风险和下周计划。",
    idea: "帮我创建工作周报流程，汇总进展、风险和下周计划",
    modelRef: null,
    status: "ready",
    revision: 3,
    groupId: "group-ops",
    templateId: null,
    createdAt: at(6),
    updatedAt: at(100),
    plan: {
      name: "工作周报流程",
      description: "汇总进展、风险和下周计划。",
      members: [
        { agentId: "agent-analyst", role: "数据汇总" },
        { agentId: "agent-writer", role: "成文润色" },
      ],
      inputs: [
        { key: "week", label: "周次", required: true, type: "text" },
        {
          key: "focus",
          label: "重点关注",
          required: false,
          type: "textarea",
        },
      ],
      steps: [
        {
          id: "collect",
          agentId: "agent-analyst",
          instruction: "汇总本周关键数据",
          inputKeys: ["week"],
          outputKey: "numbers",
        },
        {
          id: "write",
          agentId: "agent-writer",
          instruction: "根据数据写成周报",
          inputKeys: ["numbers", "focus"],
          outputKey: "report",
        },
      ],
    },
  },
  {
    id: "flow-meeting",
    name: "会议纪要流程",
    description: "整理结论、待办和负责人。",
    idea: "帮我创建会议纪要流程，整理结论、待办和负责人",
    modelRef: null,
    status: "draft",
    revision: 1,
    groupId: null,
    templateId: null,
    createdAt: at(30),
    updatedAt: at(30),
    plan: null,
  },
];

/* ------------------------------------------------------------------------------------------------ */
/* Deployment-level answers                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * `GET /api/capabilities` is read by three queries, each picking its own fields; this is the union
 * (see `server/src/app.ts`).
 */
type CapabilitiesBody = DeploymentCapabilities & {
  mode: string;
  durableHistory: boolean;
  wakerflowAutomations: boolean;
  authProviders: string[];
  ssoConfigured: boolean;
  ssoRequired: boolean;
  emailPassword: boolean;
};

const CAPABILITIES: CapabilitiesBody = {
  mode: "sse",
  durableHistory: true,
  generativeUi: false,
  wakerflowAutomations: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  transcription: false,
  voice: false,
  authProviders: [],
  ssoConfigured: false,
  ssoRequired: false,
  emailPassword: true,
};

/**
 * CopilotKit's runtime identification (`GET /api/copilotkit/info`), the subset of `RuntimeInfo` from
 * `@copilotkit/shared` that `@copilotkit/core` reads. `agents` must be an object: core calls
 * `Object.entries(runtimeInfo.agents)`, which is the "Cannot convert undefined or null to object"
 * error a bare `[]`/`{}` body produces.
 */
type CopilotRuntimeInfo = {
  version: string;
  agents: Record<string, { description: string }>;
  audioFileTranscriptionEnabled: boolean;
  mode: "sse";
};

const copilotInfo = (agents: AgentProfile[]): CopilotRuntimeInfo => ({
  version: "1.73.1",
  agents: Object.fromEntries(
    agents.map((entry) => [entry.id, { description: entry.title }]),
  ),
  audioFileTranscriptionEnabled: false,
  mode: "sse",
});

const PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: true,
  narration: null,
  skin: "openbot",
  proactive: "on",
};

const reachability = (scenario: Scenario): Reachability => ({
  bindings:
    scenario === "data"
      ? [
          {
            id: "binding-01",
            transport: "slack",
            channelId: "channel-analyst",
            agentId: "agent-analyst",
            address: "#经营周报",
            mentionId: null,
            enabled: true,
            optedOutAt: null,
          },
          {
            id: "binding-02",
            transport: "sms",
            channelId: "channel-support",
            agentId: "agent-support",
            address: "+86 138 0000 0000",
            enabled: false,
            optedOutAt: at(90),
          },
          // A chat whose last delivery failed: the table's 送达失败 state.
          {
            id: "binding-03",
            transport: "slack",
            channelId: "channel-support",
            agentId: "agent-support",
            address: "#售后支持",
            mentionId: null,
            enabled: true,
            optedOutAt: null,
          },
        ]
      : [],
  devices:
    scenario === "data"
      ? [{ id: "push-01", platform: "ios", enabled: true }]
      : [],
  deliveries:
    scenario === "data"
      ? [
          {
            id: "delivery-01",
            transport: "slack",
            kind: "reply",
            state: "sent",
            error: null,
            createdAt: at(136),
          },
          {
            id: "delivery-02",
            transport: "sms",
            kind: "question",
            state: "failed",
            error: "号码已退订",
            createdAt: at(91),
          },
          {
            id: "delivery-03",
            transport: "slack",
            kind: "reply",
            state: "failed",
            error: "机器人已被移出该频道",
            createdAt: at(60),
            bindingId: "binding-03",
          },
        ]
      : [],
  available: { slack: true, teams: false, sms: true, push: true },
});

/* ------------------------------------------------------------------------------------------------ */
/* Per-coworker answers                                                                              */
/* ------------------------------------------------------------------------------------------------ */

const lifecycleFor = (agentId: string): BotLifecycle => {
  const row = ATTENTION.find((entry) => entry.agentId === agentId);
  return {
    agentId,
    paused: row?.paused ?? false,
    pausedAt: row?.paused ? at(96) : null,
    notify: row?.notify ?? "all",
  };
};

const activityItem = (
  over: Partial<ActivityItem> & Pick<ActivityItem, "id" | "title">,
): ActivityItem => ({
  kind: "routine",
  detail: null,
  status: "done",
  at: at(120),
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...over,
});

const activityFor = (agentId: string, scenario: Scenario): BotActivity => {
  if (scenario === "empty")
    return { inProgress: [], scheduled: [], completed: [] };
  const own = TASKS.filter((row) => row.executorAgentId === agentId);
  return {
    inProgress: own
      .filter((row) => row.status === "running")
      .map((row) =>
        activityItem({
          id: `activity-${row.id}`,
          title: row.title,
          status: "running",
          at: row.updatedAt,
          stoppable: true,
        }),
      ),
    scheduled: autonomousFor(agentId).routines.map((routine) =>
      activityItem({
        id: `activity-${routine.id}`,
        title: routine.instruction,
        status: "scheduled",
        at: routine.nextRunAt,
        cancellable: true,
      }),
    ),
    completed: own
      .filter((row) => row.status === "done")
      .map((row) =>
        activityItem({
          id: `activity-${row.id}`,
          title: row.title,
          at: row.updatedAt,
        }),
      ),
  };
};

const ROUTING: UpdateRouting = {
  progress: ["push"],
  decision: "all",
  question: "all",
  attention: "all",
};

/* ------------------------------------------------------------------------------------------------ */
/* Approvals, routines, duties, projects, per-coworker grants                                       */
/* ------------------------------------------------------------------------------------------------ */

const APPROVAL_REQUESTS: ApprovalRequestData[] = [
  {
    id: "approval-01",
    status: "pending",
    createdAt: at(135.5),
    action: {
      botId: "agent-support",
      toolRef: "crm/refund_order",
      effect: "write",
      scope: "order",
      threadId: "thread-support",
      toolCallId: "call-01",
      args: { orderId: "SO-20261106-0042", amount: 50 },
      target: { orderId: "SO-20261106-0042" },
      policy: {
        behaviour: "ask",
        source: "owner_rule",
        reason: "涉及金额的操作需要先确认。",
      },
    },
  },
];

const approvalInbox = (context: Context): ApprovalInboxData => ({
  enabled: true,
  requests: list(context, APPROVAL_REQUESTS),
  rules: list(context, [
    {
      id: "rule-01",
      botId: "agent-support",
      toolRef: "crm/refund_order",
      effect: "write",
      scope: "order",
      behaviour: "ask",
    },
  ]),
  teamRules: [],
  preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
  team: {
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
    enforceDangerousCommands: true,
  },
  hostCommands: "ask",
  questions: list(context, [
    {
      id: "question-01",
      botId: "agent-analyst",
      threadId: "thread-analyst",
      question: "十月第五周的数据口径是否包含退款订单？",
      why: "两种口径的环比差异较大。",
      createdAt: at(133),
    },
  ]),
});

const employeePermissions = (botId: string): EmployeePermissions => ({
  botId,
  editable: true,
  ownedByAnother: false,
  modes: [
    { id: "mode-01", toolRef: "feishu/read_doc", behaviour: "allow" },
    { id: "mode-02", toolRef: "feishu/update_sheet", behaviour: "ask" },
  ],
  teamRules: [],
  security: {
    dangerousCommands: "ask",
    sensitivePaths: "ask",
    extraSensitivePaths: [],
    disabledDefaultPaths: [],
  },
  defaultSensitivePaths: ["~/.ssh", "~/.aws"],
  enforceDangerousCommands: true,
  customRulesEnabled: true,
});

const ROUTINES: RoutinesPage = {
  routines: [
    {
      id: "routine-01",
      agentId: "agent-analyst",
      schedule: "0 9 * * 1",
      timezone: "Asia/Shanghai",
      instruction: "每周一 09:00 汇总上周销售数据并发出经营周报",
      title: null,
      channel: {
        id: "channel-analyst",
        name: "经营周报",
        title: "经营周报",
        gone: false,
      },
      enabled: true,
      nextRunAt: at(144),
      lastRun: { status: "succeeded", at: at(120) },
    },
    {
      id: "routine-02",
      agentId: "agent-analyst",
      schedule: "0 18 * * *",
      timezone: "Asia/Shanghai",
      instruction: "每天 18:00 检查库存低于安全线的商品",
      title: null,
      channel: {
        id: "channel-analyst",
        name: "经营周报",
        title: "经营周报",
        gone: false,
      },
      enabled: false,
      nextRunAt: at(142),
      lastRun: { status: "failed", at: at(106) },
    },
    {
      id: "routine-03",
      agentId: "agent-support",
      schedule: "0 10 * * *",
      timezone: "Asia/Shanghai",
      instruction: "每天 10:00 跟进未回复超过 24 小时的工单",
      title: null,
      channel: {
        id: "channel-support",
        name: "客户咨询",
        title: "客户咨询",
        gone: false,
      },
      enabled: true,
      nextRunAt: at(138),
      lastRun: { status: "succeeded", at: at(114) },
    },
  ],
  sweep: { lastSweptAt: at(136.9), working: true },
};

const RESPONSIBILITIES: ResponsibilityRecord[] = [
  {
    id: "duty-01",
    agentId: "agent-analyst",
    channelId: "channel-analyst",
    threadId: "thread-analyst",
    title: "月底核对退款流水",
    instruction: "每月最后一天核对退款流水与财务记录是否一致。",
    successCriteria: "差异为零，或列出全部差异项。",
    status: "active",
    progress: "十月已核对完毕。",
    lastResult: "无差异。",
    subscriptions: [{ source: "schedule", eventType: "monthly" }],
    updatedAt: at(80),
  },
  {
    id: "duty-02",
    agentId: "agent-ops",
    channelId: "channel-team",
    threadId: "thread-team",
    title: "每小时巡检订单服务",
    instruction: "检查订单服务的错误率与响应时间。",
    successCriteria: "错误率低于 0.1%。",
    status: "active",
    progress: "最近一次巡检正常。",
    lastResult: null,
    subscriptions: [{ source: "schedule", eventType: "hourly" }],
    updatedAt: at(136.2),
  },
];

const projectsFor = (
  deviceRowId: string,
  agentId: string | null,
  context: Context,
): ProjectList => ({
  projects:
    context.data && deviceRowId === "device-row-1"
      ? [
          {
            id: "project-01",
            deviceId: deviceRowId,
            scope: agentId ? "agent" : "public",
            agentId,
            name: "经营数据看板",
            description: "周报用到的数据脚本与模板。",
            source: {
              kind: "local",
              rootRef: "root-docs",
              label: "项目文档",
              writable: true,
            },
            revision: 2,
            createdAt: at(12),
            updatedAt: at(100),
          },
        ]
      : [],
  currentProjectId: null,
});

const grantedPluginsFor = (
  agentId: string,
  context: Context,
): GrantedPlugins => ({
  tools: list(
    context,
    PLUGIN_SERVERS.flatMap((server) =>
      server.tools
        .filter((tool) => tool.grantedTo.includes(agentId))
        .map((tool) => ({
          ref: tool.ref,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
    ),
  ),
  skills: list(
    context,
    SKILLS.filter((skill) => skill.grantedTo.includes(agentId)).map(
      (skill) => ({
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
      }),
    ),
  ),
});

const grantedComponentsFor = (context: Context): GrantedComponent[] =>
  list(
    context,
    COMPONENTS.filter((component) => component.published).map((component) => ({
      name: component.name,
      description: component.publishedDescription ?? "",
    })),
  );

const CONTROL: ControlState = {
  holder: "bot",
  since: at(100),
  requested: false,
  recoveryRequired: false,
  transitioning: false,
  resumeSnapshotRequired: false,
};

const FLOW_RUNS: WakerFlowRunSummary[] = [
  {
    id: "run-01",
    status: "done",
    templateId: null,
    parentTaskId: "task-08",
    createdAt: at(117),
  },
  {
    id: "run-02",
    status: "failed",
    templateId: null,
    parentTaskId: null,
    createdAt: at(94),
  },
];

const FLOW_VERSIONS: WakerFlowVersionSummary[] = [
  {
    revision: 3,
    name: "工作周报流程",
    stepCount: 2,
    modelRef: null,
    templateId: null,
    createdBy: "user-demo",
    createdAt: at(100),
  },
  {
    revision: 2,
    name: "工作周报流程",
    stepCount: 1,
    modelRef: null,
    templateId: null,
    createdBy: "user-demo",
    createdAt: at(40),
  },
];

const FLOW_SESSIONS: WakerFlowSession[] = [
  {
    id: "flow-session-01",
    requestId: "request-01",
    title: "加入风险汇总",
    description: "在周报里增加风险与求助一节。",
    revision: 3,
    turnCount: 2,
    active: true,
    createdAt: at(98),
    updatedAt: at(100),
  },
];

const FLOW_SESSION_TURNS: WakerFlowSessionTurn[] = [
  {
    id: "turn-01",
    requestId: "request-01",
    prompt: "在周报最后加一节“风险与求助”。",
    modelRef: "model-deepseek",
    status: "completed",
    error: null,
    plan: null,
    applied: true,
    createdAt: at(99),
  },
];

const FLOW_MODEL_CHOICES: FlowModelChoice[] = [
  {
    id: "model-deepseek",
    name: "deepseek/deepseek-chat",
    label: "DeepSeek 通用",
  },
  { id: "model-glm", name: "zhipu/glm-4-plus", label: "智谱 GLM-4 Plus" },
];

/* ------------------------------------------------------------------------------------------------ */
/* The Bot's conversation (CopilotKit / AG-UI)                                                       */
/* ------------------------------------------------------------------------------------------------ */

const BOT_THREAD_ID = "thread-bot-demo";

const BOT_MESSAGES: Message[] = [
  {
    id: "message-01",
    role: "user",
    content: "帮我看一下上周的销售额和前一周比怎么样？",
  },
  {
    id: "message-02",
    role: "assistant",
    content:
      "上周销售额为 128.4 万元，环比增长 6.2%。增长主要来自秋季新品，线上渠道贡献了约七成。需要我把明细整理成表格吗？",
  },
];

/**
 * What `POST /api/copilotkit/agent/:id/connect` streams for a stored thread: the runtime replays the
 * thread's history as AG-UI events. Empty scenario: a stream that ends at once, which is what the
 * runtime sends for a thread it has never seen.
 */
const connectStream = (agentId: string, context: Context): string => {
  if (!context.data) return "";
  const events = [
    {
      type: EventType.RUN_STARTED,
      threadId: BOT_THREAD_ID,
      runId: `run-${agentId}`,
    },
    { type: EventType.MESSAGES_SNAPSHOT, messages: BOT_MESSAGES },
    {
      type: EventType.RUN_FINISHED,
      threadId: BOT_THREAD_ID,
      runId: `run-${agentId}`,
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
};

/* ------------------------------------------------------------------------------------------------ */
/* Router                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

type Context = {
  method: string;
  url: URL;
  params: URLSearchParams;
  match: RegExpMatchArray;
  scenario: Scenario;
  data: boolean;
  /** The parsed JSON request body, when the runner could read one. */
  body: unknown;
};

type Handler = (context: Context) => FixtureResponse | undefined;

const ok = (body: unknown): FixtureResponse => ({ status: 200, body });
const notFound = (error: string): FixtureResponse => ({
  status: 404,
  body: { error },
});

/** `list(data, items)` = the items in the data scenario, `[]` in the empty one. */
const list = <T>(context: Context, items: T[]): T[] =>
  context.data ? items : [];

/** Each area's own additions (tests/parity/extra), consulted after this file's routes. */
const EXTRA_ROUTES = [
  ...CONVERSATION_EXTRA,
  ...PEOPLE_EXTRA,
  ...WORKFLOW_EXTRA,
  ...ADMIN_EXTRA,
] as [method: string, pattern: RegExp, handler: Handler][];

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  // Identity and deployment
  ["GET", /^\/api\/me$/, () => ok({ user: USER })],
  ["GET", /^\/api\/capabilities$/, () => ok(CAPABILITIES)],
  [
    "GET",
    /^\/api\/settings\/preferences$/,
    () => ok({ preferences: PREFERENCES }),
  ],
  [
    "GET",
    /^\/api\/settings\/instructions$/,
    (c) =>
      ok({
        instructions: c.data
          ? "回答请使用简体中文；涉及金额时保留两位小数。"
          : "",
      }),
  ],
  ["GET", /^\/api\/copilotkit\/info$/, (c) => ok(copilotInfo(list(c, AGENTS)))],
  [
    // CopilotKit's single-route transport: the same identification, asked as `{ method: "info" }`.
    "POST",
    /^\/api\/copilotkit$/,
    (c) =>
      (c.body as { method?: unknown } | undefined)?.method === "info"
        ? ok(copilotInfo(list(c, AGENTS)))
        : undefined,
  ],
  ["PUT", /^\/api\/components\/catalogue$/, () => ok({ added: [] })],
  [
    "GET",
    /^\/api\/sandboxed\/published$/,
    () => ok({ components: [] satisfies PublishedSandboxed[] }),
  ],

  // Coworkers
  [
    "GET",
    /^\/api\/agents$/,
    (c) =>
      ok({
        agents: list(
          c,
          c.params.get("hidden") === "true" ? HIDDEN_AGENTS : AGENTS,
        ),
      }),
  ],
  [
    "GET",
    /^\/api\/agents\/capabilities$/,
    () => ok({ capabilities: { builtInAvailable: true } }),
  ],
  [
    "GET",
    /^\/api\/agents\/autonomous\/all$/,
    (c) =>
      ok({
        autonomous: list(
          c,
          AGENTS.map((entry) => autonomousFor(entry.id)),
        ),
      }),
  ],
  [
    "GET",
    /^\/api\/agents\/([^/]+)\/autonomous$/,
    (c) => ok({ autonomous: autonomousFor(decodeURIComponent(c.match[1]!)) }),
  ],
  [
    "GET",
    /^\/api\/agents\/([^/]+)\/handoff$/,
    () =>
      ok({
        handoff: {
          enabled: true,
          canGrant: true,
          reachable: ["agent-support"],
          grantable: true,
        },
      }),
  ],
  [
    "GET",
    /^\/api\/agents\/([^/]+)$/,
    (c) => {
      const found = list(c, ALL_AGENTS).find(
        (entry) => entry.id === decodeURIComponent(c.match[1]!),
      );
      return found ? ok({ agent: found }) : notFound("找不到这位员工");
    },
  ],
  ["GET", /^\/api\/waker-groups$/, (c) => ok({ groups: list(c, GROUPS) })],
  // The fixture's plugins and skills are written in Chinese already, so there is nothing to translate.
  ["GET", /^\/api\/translations\/plugins$/, () => ok({ zh: {} })],
  // 头像: two faces somebody chose (an expression for a coworker and for a group); none when empty.
  [
    "GET",
    /^\/api\/portraits$/,
    (c) =>
      ok({
        portraits: list(c, [
          {
            kind: "coworker",
            id: "agent-avatar",
            preset: "naughty",
            imageUrl: null,
            updatedAt: "2026-11-07T08:00:00.000Z",
          },
          {
            kind: "coworker",
            id: "agent-support",
            preset: "cute",
            imageUrl: null,
            updatedAt: "2026-11-07T08:00:00.000Z",
          },
          {
            kind: "group",
            id: "group-ops",
            preset: "happy",
            imageUrl: null,
            updatedAt: "2026-11-07T08:00:00.000Z",
          },
        ]),
      }),
  ],

  // Bots
  ["GET", /^\/api\/bots\/attention$/, (c) => ok({ bots: list(c, ATTENTION) })],
  ["GET", /^\/api\/bots\/routing$/, () => ok({ routing: ROUTING })],
  [
    "GET",
    /^\/api\/bots\/([^/]+)\/lifecycle$/,
    (c) => ok({ lifecycle: lifecycleFor(decodeURIComponent(c.match[1]!)) }),
  ],
  [
    "GET",
    /^\/api\/bots\/([^/]+)\/activity$/,
    (c) =>
      ok({
        activity: activityFor(decodeURIComponent(c.match[1]!), c.scenario),
      }),
  ],
  [
    "GET",
    /^\/api\/bots\/([^/]+)\/audit$/,
    () => ok({ scope: "everyone", events: [] }),
  ],

  // Tasks
  [
    "GET",
    /^\/api\/tasks$/,
    (c) => ok({ tasks: list(c, filterTasks(c.params)) }),
  ],

  // Conversations
  [
    "GET",
    /^\/api\/channels$/,
    (c) =>
      ok({
        channels: list(c, CHANNELS),
        nextCursor: null,
      } satisfies ChannelPage),
  ],
  [
    "GET",
    /^\/api\/channels\/([^/]+)$/,
    (c) => {
      const found = list(c, CHANNELS).find(
        (entry) => entry.id === decodeURIComponent(c.match[1]!),
      );
      return found
        ? ok({ channel: channelOf(found) })
        : notFound("找不到这段会话");
    },
  ],

  // Machines and reachability
  ["GET", /^\/api\/devices$/, (c) => ok({ devices: list(c, DEVICES) })],
  ["GET", /^\/api\/devices\/([^/]+)\/actions$/, () => ok({ actions: [] })],
  ["GET", /^\/api\/delivery$/, (c) => ok(reachability(c.scenario))],

  // Resources
  [
    "GET",
    /^\/api\/components$/,
    (c) => ok({ components: list(c, COMPONENTS) }),
  ],
  [
    "GET",
    /^\/api\/plugins$/,
    (c) =>
      ok(
        c.data
          ? PLUGINS_PAGE
          : ({
              ...PLUGINS_PAGE,
              servers: [],
              skills: [],
            } satisfies PluginsPage),
      ),
  ],
  [
    "GET",
    /^\/api\/plugins\/connections$/,
    (c) =>
      ok({
        ...PLUGIN_CONNECTIONS,
        connections: list(c, PLUGIN_CONNECTIONS.connections),
      } satisfies PluginConnections),
  ],
  [
    "GET",
    /^\/api\/plugins\/listings$/,
    (c) => ok({ listings: list(c, LISTINGS) }),
  ],
  [
    "GET",
    /^\/api\/models$/,
    (c) =>
      ok(
        c.data
          ? MODELS
          : ({ ...MODELS, models: [], pool: [] } satisfies ModelLibrary),
      ),
  ],
  [
    "GET",
    /^\/api\/knowledge\/notebooks$/,
    (c) => ok({ notebooks: list(c, NOTEBOOKS) }),
  ],
  [
    "GET",
    /^\/api\/knowledge\/notebooks\/([^/]+)$/,
    (c) => {
      const detail = c.data
        ? notebookDetail(decodeURIComponent(c.match[1]!))
        : undefined;
      return detail ? ok(detail) : notFound("读不到这个知识库。");
    },
  ],
  [
    "GET",
    /^\/api\/memory\/sources$/,
    (c) => ok({ sources: list(c, MEMORY_SOURCES) }),
  ],
  [
    "GET",
    /^\/api\/me\/avatar\/sources$/,
    (c) =>
      ok(
        c.data
          ? AVATAR_SOURCES
          : ({
              agentId: AVATAR_SOURCES.agentId,
              configuredAt: null,
              sources: [],
            } satisfies AvatarSourceState),
      ),
  ],

  // Approvals
  ["GET", /^\/api\/approvals$/, (c) => ok(approvalInbox(c))],
  [
    "GET",
    /^\/api\/approvals\/employees\/([^/]+)$/,
    (c) => ok(employeePermissions(decodeURIComponent(c.match[1]!))),
  ],
  [
    "GET",
    /^\/api\/approvals\/([^/]+)$/,
    (c) => {
      const found = list(c, APPROVAL_REQUESTS).find(
        (entry) => entry.id === decodeURIComponent(c.match[1]!),
      );
      return found ? ok(found) : notFound("读不到这条审批。");
    },
  ],

  // Routines, duties, projects
  [
    "GET",
    /^\/api\/routines$/,
    (c) =>
      ok(
        c.data
          ? ROUTINES
          : ({
              routines: [],
              sweep: { lastSweptAt: at(136.9), working: true },
            } satisfies RoutinesPage),
      ),
  ],
  [
    "GET",
    /^\/api\/responsibilities$/,
    (c) => ok({ responsibilities: list(c, RESPONSIBILITIES) }),
  ],
  [
    "GET",
    /^\/api\/projects$/,
    (c) =>
      ok(projectsFor(c.params.get("device") ?? "", c.params.get("agent"), c)),
  ],

  // Per-coworker grants and the Bot surface
  [
    "GET",
    /^\/api\/plugins\/for\/([^/]+)$/,
    (c) => ok(grantedPluginsFor(decodeURIComponent(c.match[1]!), c)),
  ],
  [
    "GET",
    /^\/api\/components\/for-agent\/([^/]+)$/,
    (c) => ok({ components: grantedComponentsFor(c) }),
  ],
  ["GET", /^\/api\/computers\/([^/]+)\/control$/, () => ok(CONTROL)],
  ["POST", /^\/api\/threads\/mint$/, () => ok({ threadId: BOT_THREAD_ID })],
  [
    "POST",
    /^\/api\/copilotkit\/agent\/([^/]+)\/connect$/,
    (c) => ({
      status: 200,
      contentType: "text/event-stream",
      body: connectStream(decodeURIComponent(c.match[1]!), c),
    }),
  ],

  // WakerFlow detail (before the `/api/wakerflows/:id` catch-all below)
  [
    "GET",
    /^\/api\/wakerflows\/model-choices$/,
    (c) => ok({ models: list(c, FLOW_MODEL_CHOICES) }),
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/sessions\/([^/]+)\/turns$/,
    (c) => ok({ turns: list(c, FLOW_SESSION_TURNS) }),
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/runs$/,
    (c) => ok({ runs: list(c, FLOW_RUNS) }),
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/versions$/,
    (c) => ok({ versions: list(c, FLOW_VERSIONS) }),
  ],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)\/sessions$/,
    (c) =>
      ok({
        sessions: list(c, FLOW_SESSIONS),
        activeSessionId: c.data ? "flow-session-01" : null,
      }),
  ],

  // Automations and WakerFlows
  [
    "GET",
    /^\/api\/automations$/,
    (c) =>
      // Current servers carry each automation's triggers on the list.
      ok({
        automations: list(c, AUTOMATIONS).map((entry) => ({
          ...entry,
          triggers: AUTOMATION_TRIGGERS[entry.id] ?? [],
        })),
      }),
  ],
  [
    "GET",
    /^\/api\/automations\/([^/]+)$/,
    (c) => {
      const id = decodeURIComponent(c.match[1]!);
      const found = list(c, AUTOMATIONS).find((entry) => entry.id === id);
      return found
        ? ok({ automation: found, triggers: AUTOMATION_TRIGGERS[id] ?? [] })
        : { status: 404, body: { error: "没有这条自动任务" } };
    },
  ],
  ["GET", /^\/api\/wakerflows$/, (c) => ok({ flows: list(c, FLOWS) })],
  [
    "GET",
    /^\/api\/wakerflows\/([^/]+)$/,
    (c) => {
      const found = list(c, FLOWS).find(
        (entry) => entry.id === decodeURIComponent(c.match[1]!),
      );
      return found
        ? ok({ flow: found })
        : notFound("这个 WakerFlow 没能加载。");
    },
  ],
];

/**
 * The fixture for one request, or `undefined` when the dataset has no answer for it (the runner then
 * logs the request as unmatched and answers 404 `{ error: "parity fixture missing" }`).
 */
export function resolveFixture(
  method: string,
  pathnameWithSearch: string,
  scenario: Scenario = "data",
  body?: unknown,
): FixtureResponse | undefined {
  const url = new URL(pathnameWithSearch, "http://parity.local");
  const upper = method.toUpperCase();
  for (const [routeMethod, pattern, handler] of [...routes, ...EXTRA_ROUTES]) {
    if (routeMethod !== upper) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    return handler({
      method: upper,
      url,
      params: url.searchParams,
      match,
      scenario,
      data: scenario === "data",
      body,
    });
  }
  return undefined;
}
