import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { CompactionResult } from "./compaction";
import type { ConversationSidebarService } from "./sidebar";

/** 一个员工 id 至多这么长；更长的不会是谁，按看不到答。 */
const AGENT_ID_LIMIT = 200;

/** 手动压缩查看者在对话里和某位员工的那条线程（`compactThread`，记在查看者名下）。 */
export type CompactConversation = (
  viewer: AgentActor,
  target: { threadId: string; agentId: string },
) => Promise<CompactionResult>;

/**
 * 对话侧栏的路由，分别挂在 `/api/threads` 和 `/api/channels` 下：
 *
 * - 读：`GET /api/threads/:threadId/sidebar` 与 `GET /api/channels/:channelId/sidebar`，`?agentId=` 选某位员工
 *   的上下文明细。
 * - 压缩会话（给了 `compact` 才挂）：`POST /api/threads/:threadId/compact` 与
 *   `POST /api/channels/:channelId/compact`，body `{agentId?}`（群组按频道压必须给）。成功 200
 *   `{compactionId, tokensBefore, tokensAfter}`；外部员工 409 `{reason:"external"}`；正在压 409
 *   `{reason:"in_progress"}`；没有可压的 409 `{reason:"too_short"}`；总结失败或出错 502 `{reason:"failed"}`；
 *   企业管控不让调用模型 403 `{reason:"refused", error:<中文原因>}`（管控读不到时 503）。
 * - 看摘要：`GET /api/threads/:threadId/compactions/:compactionId` 与
 *   `GET /api/channels/:channelId/compactions/:compactionId`，答 `{summary, summarizedCount, auto, at}`。
 *
 * 看不到的对话、不存在的对话、不在对话里的员工答同一个 404，不说是哪一种。
 */
export function createSidebarRoutes(
  service: ConversationSidebarService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  compact?: CompactConversation,
) {
  const agentIdOf = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  const notFound = { error: "Conversation not found." };

  const threads = new Hono<{ Variables: AppVariables }>();
  threads.get("/:threadId/sidebar", requireUser, async (context) => {
    const agentId = agentIdOf(context.req.query("agentId"));
    if (agentId && agentId.length > AGENT_ID_LIMIT)
      return context.json(notFound, 404);
    const sidebar = await service.forThread(
      context.var.actor,
      context.req.param("threadId"),
      agentId,
    );
    return sidebar ? context.json(sidebar) : context.json(notFound, 404);
  });

  const channels = new Hono<{ Variables: AppVariables }>();
  channels.get("/:channelId/sidebar", requireUser, async (context) => {
    const agentId = agentIdOf(context.req.query("agentId"));
    if (agentId && agentId.length > AGENT_ID_LIMIT)
      return context.json(notFound, 404);
    const sidebar = await service.forChannel(
      context.var.actor,
      context.req.param("channelId"),
      agentId,
    );
    return sidebar ? context.json(sidebar) : context.json(notFound, 404);
  });

  /*
   * 「看摘要」：`GET /api/threads/:threadId/compactions/:compactionId`（群组走
   * `/api/channels/:channelId/compactions/:compactionId`），答 `{summary, summarizedCount, auto, at}`。
   */
  const compactionRoute =
    (
      where: (
        param: (name: string) => string,
      ) => { threadId: string } | { channelId: string },
    ) =>
    async (context: Context<{ Variables: AppVariables }>) => {
      const found = await service.compaction(
        context.var.actor,
        where((name) => context.req.param(name) as string),
        context.req.param("compactionId") as string,
      );
      return found ? context.json(found) : context.json(notFound, 404);
    };
  threads.get(
    "/:threadId/compactions/:compactionId",
    requireUser,
    compactionRoute((param) => ({ threadId: param("threadId") })),
  );
  channels.get(
    "/:channelId/compactions/:compactionId",
    requireUser,
    compactionRoute((param) => ({ channelId: param("channelId") })),
  );

  if (compact) {
    const refusals = {
      external: [409, "This employee manages its own context."],
      in_progress: [409, "A compaction is already running."],
      too_short: [409, "Nothing to compact yet."],
      failed: [502, "The summary could not be written."],
    } as const;
    const refuse = (
      context: Context<{ Variables: AppVariables }>,
      reason: keyof typeof refusals,
    ) => {
      const [status, error] = refusals[reason];
      return context.json({ error, reason }, status);
    };
    const compactRoute =
      (
        where: (
          param: (name: string) => string,
        ) => { threadId: string } | { channelId: string },
      ) =>
      async (context: Context<{ Variables: AppVariables }>) => {
        const body: unknown = await context.req.json().catch(() => ({}));
        const agentId = agentIdOf(
          body && typeof body === "object"
            ? (body as { agentId?: unknown }).agentId
            : undefined,
        );
        if (agentId && agentId.length > AGENT_ID_LIMIT)
          return context.json(notFound, 404);
        const viewer = context.var.actor;
        const target = await service.compactionTarget(
          viewer,
          where((name) => context.req.param(name) as string),
          agentId,
        );
        if (!target) return context.json(notFound, 404);
        if (target.external) return refuse(context, "external");
        // 群组里还没和这位员工说过话：没有线程，也就没有可压的。
        if (!target.threadId) return refuse(context, "too_short");
        let result: CompactionResult;
        try {
          result = await compact(viewer, {
            threadId: target.threadId,
            agentId: target.agentId,
          });
        } catch {
          // 锁连接建不起来、写库失败之类：不落到框架默认的 500，答明确的失败。不记抛出的值。
          console.error({
            error: "thread_compaction_route_failed",
            context: { agentId: target.agentId },
            timestamp: new Date().toISOString(),
          });
          result = { status: "skipped", reason: "failed" };
        }
        if (result.status === "compacted")
          return context.json({
            compactionId: result.compactionId,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          });
        // 企业管控不让调用这位员工的模型：403（管控读不到时 503），带一句中文原因。
        if (result.reason === "refused")
          return context.json(
            { error: result.message, reason: "refused" },
            result.unavailable ? 503 : 403,
          );
        return refuse(context, result.reason);
      };
    threads.post(
      "/:threadId/compact",
      requireUser,
      compactRoute((param) => ({ threadId: param("threadId") })),
    );
    channels.post(
      "/:channelId/compact",
      requireUser,
      compactRoute((param) => ({ channelId: param("channelId") })),
    );
  }

  return { threads, channels };
}
