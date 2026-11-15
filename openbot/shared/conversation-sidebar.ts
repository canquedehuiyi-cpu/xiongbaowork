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
