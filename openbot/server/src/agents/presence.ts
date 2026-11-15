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
 *
 * 外部员工（`device_acp`，外部员工 Task 9）：它的电脑哪里都连不上（这台服务器没连着、别的副本也没在
 * `OFFLINE_AFTER_MS` 内听到过，由 `deviceReachable` 回答）时是「离线」，优先于暂停和在忙，带上排队数
 * （招聘人租户里还没到电脑上的轮次，`WAITING_ACP_TURN_STATUSES`）；电脑在时照常算。排队数是招聘人自己
 * 的活，只回给招聘人。
 *
 * 群里的其他成员看不到招聘人的私有员工，但它在他们的群里（招聘人还在那个群，和群名册同一条规则，
 * `channels/group-roster.ts`）时，他们也看得到它的状态和「此刻」：按招聘人读到的算（在招聘人的租户帧里读
 * 招聘人的暂停行和看板），不带排队数。
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import {
  acpTurns,
  agentProfiles,
  agents,
  botLifecycle,
  channelAgents,
  channelMemberships,
  channels,
  tasks,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { externalEmployeesAmong } from "./acp/external";
import { WAITING_ACP_TURN_STATUSES } from "./acp/turns";
import { agentAccessFilter } from "./profile-store";
import type { AgentActor } from "./profile-types";

/** 一次最多问这么多位：列表一屏的员工，远用不到。 */
export const PRESENCE_MAX_IDS = 100;

export type AgentPresenceStatus =
  | "working"
  | "resting"
  | "paused"
  | "offline"
  | "unknown";

export type AgentPresence = {
  agentId: string;
  status: AgentPresenceStatus;
  /** 正在做的那件事（运行中任务的标题），不在忙时为 null。 */
  doing: string | null;
  /** 离线的外部员工排着几件活；只在离线时、只回给招聘人。 */
  queued?: number;
};

/**
 * 外部员工的电脑此刻连不连得上：这台服务器连着它，或者别的副本最近听到过它（index.ts 用设备通道的
 * `isReachable` 和 `deviceOnlineElsewhere` 合起来回答，和轮次排队用的是同一组判断）。
 */
export type PresenceDeviceReachable = (target: {
  tenantId: string;
  deviceId: string;
}) => Promise<boolean>;

export type AgentPresenceOptions = {
  /** 没有时外部员工照普通员工算（不会离线）。 */
  deviceReachable?: PresenceDeviceReachable;
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
  options: AgentPresenceOptions = {},
): Promise<AgentPresence[]> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return [];
  const visible = await readVisiblePresence(database, actor, ids, options, {
    counted: true,
  });
  const seen = new Set(visible.map((presence) => presence.agentId));
  const unseen = ids.filter((id) => !seen.has(id));
  if (unseen.length === 0) return visible;
  return [
    ...visible,
    ...(await readGroupExternalPresence(database, actor, unseen, options)),
  ];
}

/**
 * The Bots this person may see, read in their own frame: one query, plus one for the queues of the
 * offline external employees they hired when `counted`.
 */
async function readVisiblePresence(
  database: Database,
  actor: AgentActor,
  ids: readonly string[],
  options: AgentPresenceOptions,
  { counted }: { counted: boolean },
): Promise<AgentPresence[]> {
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
      ownerUserId: agentProfiles.ownerUserId,
      pausedAt: botLifecycle.pausedAt,
      doing: sql<string | null>`(${running})`,
      type: agents.type,
      tenantId: agents.tenantId,
      deviceId: sql<string | null>`${agents.configuration}->>'deviceId'`,
    })
    .from(agentProfiles)
    // Left: a Team Bot's own row may live in a tenant this frame does not read.
    .leftJoin(agents, eq(agents.id, agentProfiles.agentId))
    .leftJoin(
      botLifecycle,
      and(
        eq(botLifecycle.agentId, agentProfiles.agentId),
        eq(botLifecycle.ownerUserId, actor.id),
      ),
    )
    .where(
      and(
        inArray(agentProfiles.agentId, [...ids]),
        isNull(agentProfiles.deletedAt),
        agentAccessFilter(actor),
      ),
    );

  const reachable = reachableOnce(options.deviceReachable);
  const offline = new Set<string>();
  if (reachable)
    await Promise.all(
      rows.map(async (row) => {
        if (row.type !== "device_acp" || !row.tenantId) return;
        if (!(await reachable(row.tenantId, row.deviceId)))
          offline.add(row.agentId);
      }),
    );
  // The count is the hirer's own work: only for the employees this person hired.
  const queued = await waitingTurns(
    database,
    actor.id,
    counted
      ? rows
          .filter(
            (row) => offline.has(row.agentId) && row.ownerUserId === actor.id,
          )
          .map((row) => row.agentId)
      : [],
  );

  return rows.map((row): AgentPresence => {
    const doing = row.doing ?? null;
    if (offline.has(row.agentId)) {
      const count = queued.get(row.agentId);
      return {
        agentId: row.agentId,
        status: "offline",
        doing: null,
        ...(count === undefined ? {} : { queued: count }),
      };
    }
    if (row.pausedAt)
      return { agentId: row.agentId, status: "paused", doing: null };
    if (doing !== null)
      return { agentId: row.agentId, status: "working", doing };
    return { agentId: row.agentId, status: "resting", doing: null };
  });
}

/**
 * `deviceReachable`, asked once per computer in one read. A computer with no id, or a check that
 * fails, reads as away: nothing can be sent to it either way.
 */
function reachableOnce(deviceReachable: PresenceDeviceReachable | undefined) {
  if (!deviceReachable) return undefined;
  const asked = new Map<string, Promise<boolean>>();
  return (tenantId: string, deviceId: string | null): Promise<boolean> => {
    if (!deviceId) return Promise.resolve(false);
    const key = JSON.stringify([tenantId, deviceId]);
    let answer = asked.get(key);
    if (!answer) {
      answer = deviceReachable({ tenantId, deviceId }).catch(() => false);
      asked.set(key, answer);
    }
    return answer;
  };
}

/** The hirer's turns of each of these employees that are not on the computer yet. */
async function waitingTurns(
  database: Database,
  hirer: string,
  agentIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map(agentIds.map((id) => [id, 0]));
  if (agentIds.length === 0) return counts;
  const rows = await database
    .select({
      agentId: acpTurns.agentId,
      count: sql<number>`count(*)::int`,
    })
    .from(acpTurns)
    .where(
      and(
        eq(acpTurns.tenantId, hirer),
        inArray(acpTurns.agentId, [...agentIds]),
        inArray(acpTurns.status, [...WAITING_ACP_TURN_STATUSES]),
      ),
    )
    .groupBy(acpTurns.agentId);
  for (const row of rows) counts.set(row.agentId, row.count);
  return counts;
}

/**
 * Somebody else's external employees this person shares a group with, while their hirer is still in
 * it (the group roster's rule): read as their hirer reads them, in the hirer's frame, with no count.
 * Which Bots are external employees, and whose, is read as `platform` (`externalEmployeesAmong`, as
 * the roster does); which groups this person is in is read in their own frame.
 */
async function readGroupExternalPresence(
  database: Database,
  actor: AgentActor,
  ids: readonly string[],
  options: AgentPresenceOptions,
): Promise<AgentPresence[]> {
  const hired = await externalEmployeesAmong(database, ids);
  if (hired.size === 0) return [];
  const me = alias(channelMemberships, "presence_me");
  const hirerMember = alias(channelMemberships, "presence_hirer");
  const shared = await database
    .selectDistinct({
      agentId: channelAgents.agentId,
      member: hirerMember.userId,
    })
    .from(channelAgents)
    .innerJoin(
      channels,
      and(eq(channels.id, channelAgents.channelId), isNull(channels.deletedAt)),
    )
    .innerJoin(
      me,
      and(eq(me.channelId, channelAgents.channelId), eq(me.userId, actor.id)),
    )
    .innerJoin(hirerMember, eq(hirerMember.channelId, channelAgents.channelId))
    .where(
      and(
        inArray(channelAgents.agentId, [...hired.keys()]),
        inArray(hirerMember.userId, [
          ...new Set([...hired.values()].map((entry) => entry.hirer)),
        ]),
      ),
    );
  const byHirer = new Map<string, Set<string>>();
  for (const row of shared) {
    const hirer = hired.get(row.agentId)?.hirer;
    if (hirer !== row.member || hirer === actor.id) continue;
    byHirer.set(hirer, (byHirer.get(hirer) ?? new Set()).add(row.agentId));
  }
  const found: AgentPresence[] = [];
  for (const [hirer, agentIds] of byHirer) {
    const seen = await runAsTenant(hirer, () =>
      readVisiblePresence(
        database,
        { id: hirer, role: "user" },
        [...agentIds],
        options,
        { counted: false },
      ),
    );
    found.push(...seen);
  }
  return found;
}
