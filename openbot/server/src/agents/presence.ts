/**
 * 员工此刻（聊天工作台 Task 8）：一次读出多位员工各自在忙、空闲还是被暂停，以及正在做的那件事。
 *
 * 和员工详情页的 `useProfileStatus` 读的是同一组事实，所以两处永远说法一致：
 * - 暂停：`bot_lifecycle` 里这个人对这位员工的那一行（`GET /api/bots/:agentId/lifecycle` 读的那一行）；
 * - 在忙：看板上执行者是它、状态是 `running` 的任务（`GET /api/tasks?executor=…&status=running` 读的那些），
 *   「此刻」写其中最近动过的那一件的标题；
 * - 暂停优先于在忙，都没有就是空闲。
 *
 * 看得到谁和员工列表同一套规则（`agentAccessFilter`，在请求人的租户里读），看不到的、不存在的、已删除的
 * 一律不回，不说为什么。整批只有一条查询，不是一位员工一条。
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles, botLifecycle, tasks } from "../db/schema";
import { agentAccessFilter } from "./profile-store";
import type { AgentActor } from "./profile-types";

/** 一次最多问这么多位：列表一屏的员工，远用不到。 */
export const PRESENCE_MAX_IDS = 100;

export type AgentPresenceStatus = "working" | "resting" | "paused" | "unknown";

export type AgentPresence = {
  agentId: string;
  status: AgentPresenceStatus;
  /** 正在做的那件事（运行中任务的标题），不在忙时为 null。 */
  doing: string | null;
};

/** What the agents routes are handed for `GET /api/agents/presence`. */
export type AgentPresenceReader = {
  read: (
    actor: AgentActor,
    agentIds: readonly string[],
  ) => Promise<AgentPresence[]>;
};

export async function readAgentPresence(
  database: Database,
  actor: AgentActor,
  agentIds: readonly string[],
): Promise<AgentPresence[]> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return [];
  const running = database
    .select({ title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.executorAgentId, agentProfiles.agentId),
        eq(tasks.status, "running"),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(1);
  const rows = await database
    .select({
      agentId: agentProfiles.agentId,
      pausedAt: botLifecycle.pausedAt,
      doing: sql<string | null>`(${running})`,
    })
    .from(agentProfiles)
    .leftJoin(
      botLifecycle,
      and(
        eq(botLifecycle.agentId, agentProfiles.agentId),
        eq(botLifecycle.ownerUserId, actor.id),
      ),
    )
    .where(
      and(
        inArray(agentProfiles.agentId, ids),
        isNull(agentProfiles.deletedAt),
        agentAccessFilter(actor),
      ),
    );
  return rows.map((row) => {
    const doing = row.doing ?? null;
    if (row.pausedAt)
      return { agentId: row.agentId, status: "paused", doing: null };
    if (doing !== null)
      return { agentId: row.agentId, status: "working", doing };
    return { agentId: row.agentId, status: "resting", doing: null };
  });
}
