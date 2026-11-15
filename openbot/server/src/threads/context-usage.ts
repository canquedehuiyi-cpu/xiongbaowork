import type { RunAgentInput } from "@ag-ui/client";
import {
  CONTEXT_SHARE_KEYS,
  type ContextShareKey,
  type ContextUsage,
} from "@openbot/shared/conversation-sidebar";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  type ContextShares,
  modelRegistry,
  modelTokenCalls,
  platformModelPool,
  threadContextBreakdowns,
} from "../db/schema";
import { DEPLOYMENT_MODEL_REF } from "../models/runtime-resolver";
import { isPersonTenant, runAsTenant } from "../tenant/context";

/**
 * 对话侧栏「上下文」一块：某员工在某对话里用了多少上下文、上限多少、分别占在哪。
 *
 * - 已用只来自 `model_token_calls`：本线程、本员工最近一次 `outcome = completed` 且 `usage_status` 为
 *   reported 或 partial 的调用（{@link usedTokens} 定口径）。取不到就是 null，不编数。
 * - 上限跟着那次调用实际用的模型走，不看员工当前配置（{@link resolveContextLimit}）。
 * - 分类是估算：每次运行开始时按组装 prompt 的各部分字数算比例，写一行 `thread_context_breakdowns`
 *   （{@link contextBreakdownRecorder}），读的时候用最近一行的比例分摊已用总量。
 */

/** 自动压缩预留占上限的比例。 */
export const AUTO_COMPACT_RESERVE = 0.1;

/**
 * 单独报缓存的服务商家族：缓存读写数不含在 `input_tokens` 里，已用要加回来。按模型库 / 平台模型池 /
 * 部署配置的服务商名（`anthropic`）或运行时 SDK 报的名字（`anthropic.messages`）认。其余（OpenAI 及
 * 兼容接口、Gemini）把缓存算在输入里。
 */
function reportsCacheSeparately(provider: string): boolean {
  const name = provider.trim().toLowerCase();
  return name === "anthropic" || name.startsWith("anthropic.");
}

/** 一次调用占用的上下文（token）：输入没报时为 null。 */
export function usedTokens(row: {
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
}): number | null {
  if (row.inputTokens === null) return null;
  if (!reportsCacheSeparately(row.provider)) return row.inputTokens;
  return (
    row.inputTokens + (row.cachedInputTokens ?? 0) + (row.cacheWriteTokens ?? 0)
  );
}

/** 模型库 / 平台模型池一行里上限相关的两列。 */
export type ContextLimitRow = {
  contextWindow: number | null;
  baseUrl: string | null;
} | null;

/** {@link resolveContextLimit} 读的三处：模型库行、平台模型池行、模型目录（不等网络）。 */
export type ContextLimitDeps = {
  registryRow: (id: string) => Promise<ContextLimitRow>;
  poolRow: (id: string) => Promise<ContextLimitRow>;
  catalogue: (
    provider: string,
    modelName: string,
    baseUrl?: string | null,
  ) => Promise<number | undefined>;
};

/**
 * 上限：绑定的模型库行 → 平台模型池行 → 按服务商 + 模型名查模型目录 → null。行在但没填上限时往下找；
 * 查目录时带上行里的接口地址，让自定义接口也能按域名认出厂商。
 */
export async function resolveContextLimit(
  input: {
    modelRef: string | null;
    platformModelRef: string | null;
    provider: string;
    modelName: string;
  },
  deps: ContextLimitDeps,
): Promise<number | null> {
  let baseUrl: string | null = null;
  if (input.modelRef) {
    const row = await deps.registryRow(input.modelRef);
    if (row?.contextWindow) return row.contextWindow;
    baseUrl = row?.baseUrl ?? null;
  }
  if (input.platformModelRef) {
    const row = await deps.poolRow(input.platformModelRef);
    if (row?.contextWindow) return row.contextWindow;
    baseUrl ??= row?.baseUrl ?? null;
  }
  return (
    (await deps.catalogue(input.provider, input.modelName, baseUrl)) ?? null
  );
}

/**
 * 按比例把 `total` 分成整数，和恰好等于 `total`：先向下取整，差的几个按小数部分从大到小补（同大按键序）。
 * 比例先归一，和不是 1 也照样分。
 */
function apportion(
  total: number,
  shares: ContextShares,
): Record<ContextShareKey, number> {
  const sum = CONTEXT_SHARE_KEYS.reduce(
    (acc, key) => acc + Math.max(0, shares[key] ?? 0),
    0,
  );
  const exact = CONTEXT_SHARE_KEYS.map((key) =>
    sum > 0 ? (total * Math.max(0, shares[key] ?? 0)) / sum : 0,
  );
  const result = exact.map(Math.floor);
  let left = total - result.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    left -= 1;
  }
  return Object.fromEntries(
    CONTEXT_SHARE_KEYS.map((key, index) => [key, result[index] ?? 0]),
  ) as Record<ContextShareKey, number>;
}

/** 由已用、上限、最近一行比例拼出侧栏要的样子。纯函数。 */
export function contextUsageFrom(input: {
  used: number | null;
  limit: number | null;
  shares: ContextShares | null;
  lastModel: { provider: string; name: string } | null;
}): ContextUsage {
  const { used, limit, shares, lastModel } = input;
  const categories: ContextUsage["categories"] = [];
  const sharesKnown =
    shares !== null && CONTEXT_SHARE_KEYS.some((key) => (shares[key] ?? 0) > 0);
  if (used !== null && sharesKnown) {
    const split = apportion(used, shares);
    for (const key of CONTEXT_SHARE_KEYS)
      categories.push({ key, tokens: split[key] });
  }
  let free: number | null = null;
  if (used !== null && limit !== null) {
    const reserve = Math.round(limit * AUTO_COMPACT_RESERVE);
    free = Math.max(0, limit - used - reserve);
    categories.push(
      { key: "reserve", tokens: reserve },
      { key: "free", tokens: free },
    );
  }
  return {
    used,
    limit,
    percent:
      used !== null && limit !== null && limit > 0
        ? Math.round((used / limit) * 1000) / 10
        : null,
    categories,
    untilAutoCompact: free,
    lastModel,
  };
}

/** {@link readContextUsage} 要的：数据库和模型目录的上下文查询（`ModelCatalogueReader.contextWindowFor`）。 */
export type ReadContextUsageDeps = {
  database: Database;
  contextWindowFor: ContextLimitDeps["catalogue"];
};

/**
 * 某员工在某对话里的上下文用量，在 `tenantId` 自己的框架里读（行级安全照常生效）。
 *
 * 模型库行还是平台模型池行，由那次调用记下的 `model_ref` 认：部署默认模型记的是全零 UUID，两边都不查；
 * 平台模型池的调用把池行 id 同时记作 `credential_id`（见 `models/runtime-resolver.ts` 的 `poolModel`）。
 */
export async function readContextUsage(
  tenantId: string,
  threadId: string,
  agentId: string,
  deps: ReadContextUsageDeps,
): Promise<ContextUsage> {
  const { database } = deps;
  return runAsTenant(tenantId, async () => {
    const [call] = await database
      .select({
        provider: modelTokenCalls.provider,
        modelName: modelTokenCalls.modelName,
        modelRef: modelTokenCalls.modelRef,
        credentialId: modelTokenCalls.credentialId,
        inputTokens: modelTokenCalls.inputTokens,
        cachedInputTokens: modelTokenCalls.cachedInputTokens,
        cacheWriteTokens: modelTokenCalls.cacheWriteTokens,
      })
      .from(modelTokenCalls)
      .where(
        and(
          eq(modelTokenCalls.tenantId, tenantId),
          eq(modelTokenCalls.threadId, threadId),
          eq(modelTokenCalls.agentId, agentId),
          eq(modelTokenCalls.outcome, "completed"),
          inArray(modelTokenCalls.usageStatus, ["reported", "partial"]),
        ),
      )
      .orderBy(desc(modelTokenCalls.startedAt))
      .limit(1);
    if (!call)
      return contextUsageFrom({
        used: null,
        limit: null,
        shares: null,
        lastModel: null,
      });

    const deployment = call.modelRef === DEPLOYMENT_MODEL_REF;
    const pooled = !deployment && call.credentialId === call.modelRef;
    const limit = await resolveContextLimit(
      {
        modelRef: deployment || pooled ? null : call.modelRef,
        platformModelRef: pooled ? call.modelRef : null,
        provider: call.provider,
        modelName: call.modelName,
      },
      {
        registryRow: async (id) => {
          const [row] = await database
            .select({
              contextWindow: modelRegistry.contextWindow,
              baseUrl: modelRegistry.baseUrl,
            })
            .from(modelRegistry)
            .where(eq(modelRegistry.id, id))
            .limit(1);
          return row ?? null;
        },
        poolRow: async (id) => {
          const [row] = await database
            .select({
              contextWindow: platformModelPool.contextWindow,
              baseUrl: platformModelPool.baseUrl,
            })
            .from(platformModelPool)
            .where(eq(platformModelPool.id, id))
            .limit(1);
          return row ?? null;
        },
        catalogue: deps.contextWindowFor,
      },
    );
    const [breakdown] = await database
      .select({ shares: threadContextBreakdowns.shares })
      .from(threadContextBreakdowns)
      .where(
        and(
          eq(threadContextBreakdowns.tenantId, tenantId),
          eq(threadContextBreakdowns.threadId, threadId),
          eq(threadContextBreakdowns.agentId, agentId),
        ),
      )
      .orderBy(desc(threadContextBreakdowns.createdAt))
      .limit(1);
    return contextUsageFrom({
      used: usedTokens(call),
      limit,
      shares: breakdown?.shares ?? null,
      lastModel: { provider: call.provider, name: call.modelName },
    });
  });
}

/** 一段 prompt 的类别和字数。 */
export type ContextSection = { key: ContextShareKey; chars: number };

/** 各类字数占总字数的比例，五个键都在；总字数为 0 时全是 0。 */
export function promptShares(
  sections: readonly ContextSection[],
): ContextShares {
  const chars = Object.fromEntries(
    CONTEXT_SHARE_KEYS.map((key) => [key, 0]),
  ) as ContextShares;
  for (const section of sections)
    chars[section.key] += Math.max(0, section.chars);
  const total = CONTEXT_SHARE_KEYS.reduce((acc, key) => acc + chars[key], 0);
  return Object.fromEntries(
    CONTEXT_SHARE_KEYS.map((key) => [key, total > 0 ? chars[key] / total : 0]),
  ) as ContextShares;
}

/**
 * 系统提示里不算「人设与系统提示」的段：其余所有段（身份、人设、手册、指令、工作规则、电脑、运行方式、
 * 模型与日期、选用的技能……，以及以后新加的）都算 `system`。
 */
const PROMPT_SECTION_CATEGORIES: Readonly<Record<string, ContextShareKey>> = {
  apps: "tools",
  learned_skills: "skills",
};

/** 个人记忆中间件放进 `RunAgentInput.context` 的那一条（`memory/tools.ts`）。 */
const PERSONAL_MEMORY_CONTEXT = "OpenBot personal memory";

/** 一次运行用的配置里与字数有关的部分：系统提示和配置的工具。 */
export type ContextBreakdownConfiguration = {
  prompt?: string;
  tools?: readonly {
    name: string;
    description?: string;
    parameters?: unknown;
  }[];
};

/** 写一行分类比例要的：哪次运行、哪个员工、发给模型的是什么。 */
export type ContextBreakdownRun = {
  configuration: ContextBreakdownConfiguration;
  input: Pick<RunAgentInput, "messages" | "context" | "state" | "tools">;
  /** 等在工具搜索后面、这一步不发的工具名。 */
  waiting?: ReadonlySet<string>;
};

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value))
    return value.reduce(
      (acc: number, part: unknown) =>
        acc +
        (part && typeof part === "object" && "text" in part
          ? textLength((part as { text?: unknown }).text)
          : 0),
      0,
    );
  return 0;
}

function schemaLength(parameters: unknown): number {
  if (parameters === undefined || parameters === null) return 0;
  try {
    const schema =
      parameters instanceof z.ZodType ? z.toJSONSchema(parameters) : parameters;
    return JSON.stringify(schema)?.length ?? 0;
  } catch {
    // 转不出 schema 的工具只算名字和说明。
    return 0;
  }
}

/**
 * 一次运行发给模型的东西按类别数字数，和 CopilotKit 内置 agent 拼请求的方式一致：系统提示 = 配置的
 * prompt + `context` 各条 + 状态；历史消息里的 system / developer 不发；工具 = 请求带的 + 配置的（同名
 * 算一个）减去等在搜索后面的。字数为 0 的段不列。
 */
export function runContextSections(run: ContextBreakdownRun): ContextSection[] {
  const sections: ContextSection[] = [];
  const add = (key: ContextShareKey, chars: number) => {
    if (chars > 0) sections.push({ key, chars });
  };

  let rest = run.configuration.prompt ?? "";
  for (const [tag, key] of Object.entries(PROMPT_SECTION_CATEGORIES)) {
    const block = new RegExp(`^<${tag}>\\n[\\s\\S]*?\\n</${tag}>$`, "gm");
    rest = rest.replace(block, (match) => {
      add(key, match.length);
      return "";
    });
  }
  add("system", rest.length);

  for (const entry of run.input.context ?? []) {
    if (entry.description === PERSONAL_MEMORY_CONTEXT)
      add("memory", entry.value.length);
    else add("system", entry.description.length + entry.value.length);
  }
  const state = run.input.state;
  if (
    state !== undefined &&
    state !== null &&
    !(typeof state === "object" && Object.keys(state).length === 0)
  )
    add("system", JSON.stringify(state)?.length ?? 0);

  for (const message of run.input.messages ?? []) {
    if (message.role === "system" || message.role === "developer") continue;
    let chars = textLength((message as { content?: unknown }).content);
    for (const call of (message as { toolCalls?: unknown[] }).toolCalls ?? []) {
      const fn = (
        call as { function?: { name?: unknown; arguments?: unknown } }
      ).function;
      chars += textLength(fn?.name) + textLength(fn?.arguments);
    }
    add("messages", chars);
  }

  const waiting = run.waiting ?? new Set<string>();
  const tools = new Map<string, number>();
  for (const tool of run.input.tools ?? [])
    tools.set(
      tool.name,
      tool.name.length +
        textLength(tool.description) +
        schemaLength(tool.parameters),
    );
  for (const tool of run.configuration.tools ?? [])
    tools.set(
      tool.name,
      tool.name.length +
        textLength(tool.description) +
        schemaLength(tool.parameters),
    );
  for (const [name, chars] of tools)
    if (!waiting.has(name)) add("tools", chars);
  return sections;
}

/** 运行开始时记一行分类比例；从不抛错，也不等写库。 */
export type RecordContextBreakdown = (
  run: ContextBreakdownRun & {
    runId: string;
    threadId: string;
    agentId: string;
  },
) => void;

/**
 * 写到 `tenantId`（发起这次运行的人）名下的记录器。字数统计和写库都推到下一轮事件循环，失败只记日志
 * （不带抛出的值：数据库错误里可能有连接信息或行内容），运行照常。不是某个人的租户时不写。
 */
export function contextBreakdownRecorder(
  database: Database,
  tenantId: string,
): RecordContextBreakdown {
  return (run) => {
    if (!isPersonTenant(tenantId)) return;
    setTimeout(() => {
      void (async () => {
        const shares = promptShares(runContextSections(run));
        if (CONTEXT_SHARE_KEYS.every((key) => shares[key] === 0)) return;
        await runAsTenant(tenantId, () =>
          database.insert(threadContextBreakdowns).values({
            tenantId,
            threadId: run.threadId,
            agentId: run.agentId,
            runId: run.runId,
            shares,
          }),
        );
      })().catch(() => {
        console.error({
          error: "thread_context_breakdown_write_failed",
          context: { agentId: run.agentId, runId: run.runId },
          timestamp: new Date().toISOString(),
        });
      });
    }, 0);
  };
}
