import type { RunAgentInput } from "@ag-ui/client";
import { and, desc, eq, inArray, max, notLike } from "drizzle-orm";
import { z } from "zod";
import {
  CONTEXT_SHARE_KEYS,
  type ContextShareKey,
  type ContextUsage,
} from "../../../shared/conversation-sidebar";
import type { Database } from "../db/client";
import {
  type ContextShares,
  modelRegistry,
  modelTokenCalls,
  platformModelPool,
  threadContextBreakdowns,
} from "../db/schema";
import { PERSONAL_MEMORY_CONTEXT } from "../memory/tools";
import { DEPLOYMENT_MODEL_REF } from "../models/runtime-resolver";
import { isPersonTenant, runAsTenant } from "../tenant/context";

/**
 * 对话侧栏「上下文」一块：某员工在某对话里用了多少上下文、上限多少、分别占在哪。
 *
 * - 已用只来自 `model_token_calls`：本线程、本员工最近一次 `outcome = completed` 且 `usage_status` 为
 *   reported 或 partial 的调用（{@link usedTokens} 定口径），压缩那次总结调用不算。取不到就是 null，不编数。
 * - 上限跟着那次调用实际用的模型走，不看员工当前配置（{@link resolveContextLimit}）。
 * - 分类是估算：每次运行开始时按组装 prompt 的各部分字数算比例，写一行 `thread_context_breakdowns`
 *   （{@link contextBreakdownRecorder}），读的时候用最近一行的比例分摊已用总量。
 */

/** 自动压缩预留占上限的比例。 */
export const AUTO_COMPACT_RESERVE = 0.1;

/**
 * 压缩会话那次总结调用的运行 id 前缀（`threads/compaction.ts`）。那次调用照常计量、算在本线程，但它的输入是
 * 被总结的历史，不是员工这一轮的上下文，所以「已用」不取它。
 */
export const COMPACTION_RUN_PREFIX = "compaction:";

/** 已用的口径：本线程、本员工、已结束、报了用量、不是压缩那次总结调用。 */
function countedCalls(tenantId: string) {
  return and(
    eq(modelTokenCalls.tenantId, tenantId),
    eq(modelTokenCalls.outcome, "completed"),
    inArray(modelTokenCalls.usageStatus, ["reported", "partial"]),
    notLike(modelTokenCalls.runId, `${COMPACTION_RUN_PREFIX}%`),
  );
}

/**
 * 一次调用占用的上下文（token）= 计量记录的 `input_tokens`；没报时为 null。
 *
 * 对所有服务商都一样：AI SDK v3 报的输入总数已含缓存读写（如 `@ai-sdk/anthropic` 的
 * `inputTokens.total = input + cacheCreation + cacheRead`），`token-metering.ts` 存的就是这个总数，
 * 所以 `cached_input_tokens` / `cache_write_tokens` 不再另加，否则会重复计算。`provider` 与缓存两列留在
 * 参数里，供接口稳定和日后核对。
 */
export function usedTokens(row: {
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
}): number | null {
  return row.inputTokens;
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
 *
 * 分类比例默认也在 `tenantId` 里读；`sharesTenantId` 给出时改在那个租户里读：员工用主人的模型库时计量行
 * 记在主人名下，比例行却记在发起运行的人名下（`contextBreakdownRecorder`），两者各在写入的租户里读。
 */
export async function readContextUsage(
  tenantId: string,
  threadId: string,
  agentId: string,
  deps: ReadContextUsageDeps,
  options: { sharesTenantId?: string } = {},
): Promise<ContextUsage> {
  const usages = await readContextUsages(
    [{ tenantId, threadId, agentId }],
    deps,
    options,
  );
  return usages.get(contextUsageKey(threadId, agentId)) as ContextUsage;
}

/** 一次要读的一位员工在一条线程里的用量，以及它的计量行写在哪个租户。 */
export type ContextUsageRequest = {
  tenantId: string;
  threadId: string;
  agentId: string;
};

/** {@link readContextUsages} 结果的键。 */
export function contextUsageKey(threadId: string, agentId: string): string {
  return `${threadId}\u0000${agentId}`;
}

const NO_USAGE = (): ContextUsage =>
  contextUsageFrom({ used: null, limit: null, shares: null, lastModel: null });

/**
 * {@link readContextUsage} 一次读一批（侧栏群组每位员工一条线程）：每个计量租户读一次最近调用
 * （`DISTINCT ON (thread_id, agent_id)`）、一次模型库行、一次平台模型池行；每个比例租户读一次最近比例。
 * 查询条数不随员工数增长。每个请求都在结果里，键是 {@link contextUsageKey}；同一线程 + 员工只读一份。
 */
export async function readContextUsages(
  requests: readonly ContextUsageRequest[],
  deps: ReadContextUsageDeps,
  options: { sharesTenantId?: string } = {},
): Promise<Map<string, ContextUsage>> {
  const { database } = deps;
  const result = new Map<string, ContextUsage>();
  for (const request of requests)
    result.set(contextUsageKey(request.threadId, request.agentId), NO_USAGE());

  const byTenant = new Map<string, ContextUsageRequest[]>();
  for (const request of requests)
    byTenant.set(request.tenantId, [
      ...(byTenant.get(request.tenantId) ?? []),
      request,
    ]);

  type Call = {
    threadId: string | null;
    agentId: string;
    provider: string;
    modelName: string;
    modelRef: string;
    credentialId: string;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteTokens: number | null;
  };
  const found: {
    request: ContextUsageRequest;
    call: Call;
    limit: number | null;
  }[] = [];
  for (const [tenantId, batch] of byTenant) {
    const wanted = new Set(
      batch.map((request) =>
        contextUsageKey(request.threadId, request.agentId),
      ),
    );
    await runAsTenant(tenantId, async () => {
      const calls = (
        await database
          .selectDistinctOn(
            [modelTokenCalls.threadId, modelTokenCalls.agentId],
            {
              threadId: modelTokenCalls.threadId,
              agentId: modelTokenCalls.agentId,
              provider: modelTokenCalls.provider,
              modelName: modelTokenCalls.modelName,
              modelRef: modelTokenCalls.modelRef,
              credentialId: modelTokenCalls.credentialId,
              inputTokens: modelTokenCalls.inputTokens,
              cachedInputTokens: modelTokenCalls.cachedInputTokens,
              cacheWriteTokens: modelTokenCalls.cacheWriteTokens,
            },
          )
          .from(modelTokenCalls)
          .where(
            and(
              countedCalls(tenantId),
              inArray(modelTokenCalls.threadId, [
                ...new Set(batch.map((request) => request.threadId)),
              ]),
              inArray(modelTokenCalls.agentId, [
                ...new Set(batch.map((request) => request.agentId)),
              ]),
            ),
          )
          .orderBy(
            modelTokenCalls.threadId,
            modelTokenCalls.agentId,
            desc(modelTokenCalls.startedAt),
          )
      ).filter(
        (call) =>
          call.threadId !== null &&
          wanted.has(contextUsageKey(call.threadId, call.agentId)),
      );
      if (calls.length === 0) return;

      const kindOf = (call: Call) => {
        const deployment = call.modelRef === DEPLOYMENT_MODEL_REF;
        const pooled = !deployment && call.credentialId === call.modelRef;
        return { deployment, pooled };
      };
      const registryIds = [
        ...new Set(
          calls.flatMap((call) => {
            const { deployment, pooled } = kindOf(call);
            return deployment || pooled ? [] : [call.modelRef];
          }),
        ),
      ];
      const poolIds = [
        ...new Set(
          calls.flatMap((call) => (kindOf(call).pooled ? [call.modelRef] : [])),
        ),
      ];
      const registryRows = new Map(
        registryIds.length > 0
          ? (
              await database
                .select({
                  id: modelRegistry.id,
                  contextWindow: modelRegistry.contextWindow,
                  baseUrl: modelRegistry.baseUrl,
                })
                .from(modelRegistry)
                .where(inArray(modelRegistry.id, registryIds))
            ).map((row) => [row.id, row])
          : [],
      );
      const poolRows = new Map(
        poolIds.length > 0
          ? (
              await database
                .select({
                  id: platformModelPool.id,
                  contextWindow: platformModelPool.contextWindow,
                  baseUrl: platformModelPool.baseUrl,
                })
                .from(platformModelPool)
                .where(inArray(platformModelPool.id, poolIds))
            ).map((row) => [row.id, row])
          : [],
      );
      for (const call of calls) {
        const { deployment, pooled } = kindOf(call);
        const limit = await resolveContextLimit(
          {
            modelRef: deployment || pooled ? null : call.modelRef,
            platformModelRef: pooled ? call.modelRef : null,
            provider: call.provider,
            modelName: call.modelName,
          },
          {
            registryRow: async (id) => registryRows.get(id) ?? null,
            poolRow: async (id) => poolRows.get(id) ?? null,
            catalogue: deps.contextWindowFor,
          },
        );
        const request = batch.find(
          (entry) =>
            entry.threadId === call.threadId && entry.agentId === call.agentId,
        ) as ContextUsageRequest;
        found.push({ request, call, limit });
      }
    });
  }
  if (found.length === 0) return result;

  // 比例只为有用量的线程 + 员工读，按比例所在的租户一次读完。
  const bySharesTenant = new Map<string, typeof found>();
  for (const entry of found) {
    const tenant = options.sharesTenantId ?? entry.request.tenantId;
    bySharesTenant.set(tenant, [...(bySharesTenant.get(tenant) ?? []), entry]);
  }
  for (const [tenant, batch] of bySharesTenant) {
    const shares = new Map(
      (
        await runAsTenant(tenant, () =>
          database
            .selectDistinctOn(
              [
                threadContextBreakdowns.threadId,
                threadContextBreakdowns.agentId,
              ],
              {
                threadId: threadContextBreakdowns.threadId,
                agentId: threadContextBreakdowns.agentId,
                shares: threadContextBreakdowns.shares,
              },
            )
            .from(threadContextBreakdowns)
            .where(
              and(
                eq(threadContextBreakdowns.tenantId, tenant),
                inArray(threadContextBreakdowns.threadId, [
                  ...new Set(batch.map((entry) => entry.request.threadId)),
                ]),
                inArray(threadContextBreakdowns.agentId, [
                  ...new Set(batch.map((entry) => entry.request.agentId)),
                ]),
              ),
            )
            .orderBy(
              threadContextBreakdowns.threadId,
              threadContextBreakdowns.agentId,
              desc(threadContextBreakdowns.createdAt),
            ),
        )
      ).map((row) => [contextUsageKey(row.threadId, row.agentId), row.shares]),
    );
    for (const { request, call, limit } of batch) {
      const key = contextUsageKey(request.threadId, request.agentId);
      result.set(
        key,
        contextUsageFrom({
          used: usedTokens(call),
          limit,
          shares: shares.get(key) ?? null,
          lastModel: { provider: call.provider, name: call.modelName },
        }),
      );
    }
  }
  return result;
}

/**
 * 「已用」取的那次调用是什么时候开始的（口径同 {@link readContextUsage}），在 `tenantId` 的帧里读；没有时为
 * null。自动压缩用它判断上一轮的用量是不是压缩之前的旧数。
 */
export async function latestUsageCallAt(
  database: Database,
  tenantId: string,
  threadId: string,
  agentId: string,
): Promise<Date | null> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .select({ at: max(modelTokenCalls.startedAt) })
      .from(modelTokenCalls)
      .where(
        and(
          countedCalls(tenantId),
          eq(modelTokenCalls.threadId, threadId),
          eq(modelTokenCalls.agentId, agentId),
        ),
      ),
  );
  return row?.at ?? null;
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

/**
 * 压缩会话的摘要放进 `RunAgentInput.context` 的那一条（`threads/compaction.ts`）。它是对话历史的替身，算
 * `messages`，不算系统提示：内置员工丢掉历史里的 system 行，所以摘要只能这样送到模型面前。
 */
export const COMPACTION_SUMMARY_CONTEXT = "Earlier conversation summary";

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
 * 一次运行发给模型的东西按类别数字数，和内置员工运行时拼请求的方式一致：系统提示 = 配置的
 * prompt + `context` 各条 + 状态（`context` 里压缩摘要那条算消息）；历史消息里的 system / developer 不发；
 * 工具 = 请求带的 + 配置的（同名算一个）减去等在搜索后面的。字数为 0 的段不列。
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
    else if (entry.description === COMPACTION_SUMMARY_CONTEXT)
      add("messages", entry.value.length);
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
