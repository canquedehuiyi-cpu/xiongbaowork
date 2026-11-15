/**
 * 对话侧栏（员工 / 群聊右侧面板）前后端共用的类型。
 *
 * 上下文一块：总量是服务商报的真实输入 token（`model_token_calls` 最近一次调用），上限来自模型库或模型目录，
 * 分类是按组装 prompt 时各部分字数比例分摊的估算。取不到的一律是 null，不编数。
 */

/** 上下文占用的五个分类，顺序即显示顺序。 */
export const CONTEXT_SHARE_KEYS = [
  "messages",
  "system",
  "tools",
  "skills",
  "memory",
] as const;
export type ContextShareKey = (typeof CONTEXT_SHARE_KEYS)[number];

/** 分类条上的一段：五个分类，加上派生的自动压缩预留和空余。 */
export type ContextCategoryKey = ContextShareKey | "reserve" | "free";

export type ContextUsage = {
  /** 已用 token：最近一次调用的真实输入；没有可用调用时为 null。 */
  used: number | null;
  /** 上下文上限（token）；模型库、平台模型池和模型目录都没有时为 null。 */
  limit: number | null;
  /** 已用占上限的百分比（保留一位小数）；已用或上限未知时为 null。 */
  percent: number | null;
  /**
   * 分类明细。已用已知且有分类比例时含五个分类（按比例分摊，和 = 已用）；已用与上限都已知时再加
   * `reserve`（上限的 10%）和 `free`（上限 − 已用 − 预留，不小于 0）。都不知道时为空数组。
   */
  categories: { key: ContextCategoryKey; tokens: number }[];
  /** 距自动压缩还剩的 token（= 空余）；已用或上限未知时为 null。 */
  untilAutoCompact: number | null;
  /** 最近一次调用实际用的服务商和模型名；没有调用时为 null。 */
  lastModel: { provider: string; name: string } | null;
};

/*
 * 侧栏接口（`GET /api/threads/:threadId/sidebar`、`GET /api/channels/:channelId/sidebar`）一次返回的四块。
 * 单聊和群组共用一个形状：群组多出 `environment.members` 与 `context.perAgent`。
 */

/** 员工此刻：在忙、空闲、被暂停、所在电脑离线，或读不到。 */
export type SidebarMemberStatus =
  | "working"
  | "resting"
  | "paused"
  | "offline"
  | "unknown";

/** 环境：员工在哪干活、在哪个项目或工作文件夹、用什么模型；群组里是成员列表。 */
export type SidebarEnvironment = {
  kind: "cloud" | "device";
  /** 设备模式与外部员工：电脑名；看不到那台电脑时不给。 */
  deviceName?: string;
  online?: boolean;
  /** 设备模式下员工在这台电脑上的当前项目；没有时为 null。 */
  project?: { id: string; name: string } | null;
  /** 外部员工的工作文件夹名（设备上报的共享文件夹名）；对不上时为 null。 */
  workdirName?: string | null;
  /** 员工绑定的模型；外部员工带 `external`；远程员工与群组为 null。 */
  model: { label: string; external?: { harness: string } } | null;
  members?: {
    agentId: string;
    name: string;
    status: SidebarMemberStatus;
    /** 在哪：「云端」、电脑名，或看不到电脑名时的「电脑」。 */
    where: string;
    doing: string | null;
  }[];
};

/** 任务卡的五种状态（同看板）。 */
export type SidebarGoalStatus =
  | "running"
  | "needs_action"
  | "awaiting_review"
  | "done"
  | "failed";

/** 目标：最近一张任务卡；没有卡时为 null。 */
export type SidebarGoal = {
  title: string;
  status: SidebarGoalStatus;
  /** 这个对话跑过几轮（`thread_runs` 计数）。 */
  rounds: number;
  /** 状态一句话，加员工最近一条回复的第一句（截 60 字）。 */
  lastCheck: string;
  /** 这个对话（群组里是查看者自己的线程）里最新一个还挂着的审批；没有时为 null。 */
  pendingApprovalId: string | null;
} | null;

/** 上下文：用量与分类明细；外部员工只有 `managedBy`；群组每位员工一行 `perAgent`。 */
export type SidebarContext = {
  /** 外部员工：上下文由谁自己管理（如「Codex」）。 */
  managedBy?: string;
  usage?: ContextUsage;
  perAgent?: {
    agentId: string;
    name: string;
    /** 已用与上限（token），同 `ContextUsage`；外部员工与取不到时为 null。 */
    used: number | null;
    limit: number | null;
    percent: number | null;
    managedBy?: string;
    compactedAt?: string | null;
  }[];
  lastCompaction?: { id: string; auto: boolean; at: string } | null;
};

/** 输出内容一行：文件（附件）、表格、链接、改动、报告。 */
export type SidebarOutput = {
  kind: "file" | "table" | "link" | "diff" | "report";
  title: string;
  href: string;
  at: string;
  byAgentId?: string;
};

/** 侧栏可显示的输出内容条数，多出来的看「查看全部 N 项」。 */
export const SIDEBAR_OUTPUT_LIMIT = 3;

export type ConversationSidebar = {
  environment: SidebarEnvironment;
  goal: SidebarGoal;
  context: SidebarContext;
  /** 按时间倒序、去重；`items` 最多 {@link SIDEBAR_OUTPUT_LIMIT} 条，`total` 是去重后的总数。 */
  outputs: { items: SidebarOutput[]; total: number };
};
