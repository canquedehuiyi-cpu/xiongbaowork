import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { ConversationSidebarService } from "./sidebar";

/** 一个员工 id 至多这么长；更长的不会是谁，按看不到答。 */
const AGENT_ID_LIMIT = 200;

/**
 * 对话侧栏的两条读路由：`GET /api/threads/:threadId/sidebar` 与 `GET /api/channels/:channelId/sidebar`，
 * `?agentId=` 选某位员工的上下文明细。分别挂在 `/api/threads` 和 `/api/channels` 下。
 *
 * 看不到的对话、不存在的对话、不在对话里的员工答同一个 404，不说是哪一种。
 */
export function createSidebarRoutes(
  service: ConversationSidebarService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const agentIdOf = (value: string | undefined) =>
    value === undefined || value === "" ? undefined : value;
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

  return { threads, channels };
}
