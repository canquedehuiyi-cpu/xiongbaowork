import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isOnRoster, isPendingSummon } from "@/components/app-sidebar/roster";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  ownerPresence,
  presenceOf,
  presenceWord,
} from "@/lib/devices/presence";
import { devicesQueryOptions } from "@/lib/devices/queries";
import {
  monthTaskStatsQueryOptions,
  runningTasksQueryOptions,
  taskStatsOf,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";
import type { CardStats, DeviceLine } from "./coworker-card";
import type { WakerSort, WakerStatus, WakersSearch } from "./wakers-search";

/*
 * 员工页（`/bots`）每位员工的事实：状态、设备环境、本月任务数与最近运行、群组、需要你、是不是个人分身。
 * 从熊宝员工墙（原 `/wakers`）搬来（M5b），工具栏和名单（卡片与列表两种画法）读的是同一份，所以筛选的计数和
 * 画出来的员工永远一致。每个读取各自失败、各自说明，一个读不到不会让整页空掉。
 */

/**
 * Three states, each read from a fact that already exists — never a stored status column.
 *
 * `working` is a task card running right now. `paused` is the bot_lifecycle pause (spec D4): the
 * signed-in person switched this coworker off from `/api/bots/:id/pause`, which the attention read
 * (`GET /api/bots/attention`) reports per coworker. Everything else rests.
 *
 * `paused` used to be read off the roster's `hidden` flag. That flag only decides whether a
 * coworker is listed; a hidden coworker still runs, and a paused one can still be listed, so the
 * two are shown apart: hidden is its own 已隐藏 section and tag beside whichever of the states is
 * true.
 *
 * The fourth one is not a status, it is this screen admitting it is blind. When the pause read
 * fails (or has not answered yet) the screen cannot tell 暂停 from anything else, and when the board
 * read fails it cannot tell 在线 from 休息; either way each card says 状态未知 rather than guessing.
 * A coworker the pause read does name as paused stays paused even when the board is unreadable.
 */
function statusFor(
  agent: AgentProfile,
  running: Set<string>,
  pausedIds: Set<string> | null,
  runningUnknown: boolean,
): WakerStatus {
  if (pausedIds === null) return "unknown";
  if (pausedIds.has(agent.id)) return "paused";
  if (runningUnknown) return "unknown";
  return running.has(agent.id) ? "working" : "resting";
}

export const STATUS_ORDER: readonly WakerStatus[] = [
  "working",
  "resting",
  "paused",
  "unknown",
];

export function useRosterFacts() {
  const agents = useQuery(agentListQueryOptions());
  /*
   * The coworkers switched out of the list, which `GET /api/agents` leaves out: `?hidden=true`
   * answers only them. Read apart and shown in their own folded 已隐藏 section, each with an 已隐藏
   * tag, because hidden is about whether a coworker is listed and says nothing about whether it is
   * paused. If this read fails the active roster still renders.
   */
  const hidden = useQuery(agentListQueryOptions(true));
  const groups = useQuery(wakerGroupsQueryOptions());
  const running = useQuery(runningTasksQueryOptions());
  /** Spec D4's 暂停 = bot_lifecycle paused, which this read carries for every paused coworker. */
  const attention = useQuery(botAttentionQueryOptions());
  /** Spec F4: this person's machines and whether each is online, for the device line on each card. */
  const devices = useQuery(devicesQueryOptions());
  /** The board's month, which each card's 任务数 and 最近运行 are counted from. */
  const month = useQuery(monthTaskStatsQueryOptions());
  /*
   * Story F1 (spec D2): the person's 分身 reads 待配置 until they save its first information source.
   * Only said when the read answered: a failed read is not "unconfigured", so it says nothing.
   */
  const avatarSources = useQuery(avatarSourcesQueryOptions());
  const unconfiguredAvatar =
    avatarSources.data && avatarSources.data.configuredAt === null
      ? avatarSources.data.agentId
      : null;
  /** The person's own 分身: tagged 个人分身, and first under 你的. */
  const avatarAgentId = avatarSources.data?.agentId ?? null;

  /*
   * Spec F4's device line on a coworker's card, which is also its 环境. A running task bound to a
   * machine names THAT machine and whether it is online (the task's own `deviceId`). Without one
   * there is no binding to read, so the line says what this person's machines are doing and says
   * that this is what it is -- and only on their own coworkers, whose work would run on those
   * machines. Cloud mode, or nobody paired: no machine to name, so the card says 未绑定设备.
   */
  const deviceLineOf = (agent: AgentProfile): DeviceLine | null => {
    const bound = (running.data ?? []).find(
      (task) => task.executorAgentId === agent.id && task.deviceId,
    );
    const machine = presenceOf(bound?.deviceId, devices.data);
    if (machine)
      return {
        kind: "task",
        online: machine.online,
        text: `设备：${machine.name} · ${presenceWord(machine.online)}`,
      };
    const owner = agent.mine ? ownerPresence(devices.data) : null;
    if (!owner) return null;
    return {
      kind: "owner",
      online: owner.online > 0,
      text: `你的设备：${owner.online}/${owner.total} 台在线（没有进行中的任务绑定到具体设备）`,
    };
  };

  /*
   * The person's employees (召唤员工 Task 10): a preset original they already summoned is not on
   * 人才市场 at all (their copy is the one they have), and one still 待召唤 is in its own section, so
   * neither is counted, filtered by role or status, or listed here. `pending` is that section.
   */
  const everyone = useMemo(
    () => [...(agents.data ?? []), ...(hidden.data ?? [])],
    [agents.data, hidden.data],
  );
  const roster = useMemo(() => everyone.filter(isOnRoster), [everyone]);
  const pending = useMemo(() => everyone.filter(isPendingSummon), [everyone]);
  const workingIds = useMemo(
    () => new Set((running.data ?? []).map((task) => task.executorAgentId)),
    [running.data],
  );
  /** Each employee's attention row, for the 需要你 line on its card and the count on its row. */
  const attentionById = useMemo(
    () =>
      new Map<string, BotAttention>(
        (attention.data ?? []).map((bot) => [bot.agentId, bot]),
      ),
    [attention.data],
  );
  const pausedIds = useMemo(
    () =>
      attention.data
        ? new Set(
            attention.data
              .filter((bot) => bot.paused)
              .map((bot) => bot.agentId),
          )
        : null,
    [attention.data],
  );
  const stats = useMemo(
    () => (month.data ? taskStatsOf(month.data) : null),
    [month.data],
  );
  const statusOf = (agent: AgentProfile) =>
    statusFor(agent, workingIds, pausedIds, running.isError);
  const statsOf = (agent: AgentProfile): CardStats =>
    stats
      ? {
          stats: stats.byAgent.get(agent.id) ?? { count: 0, lastRunAt: null },
          truncated: stats.truncated,
        }
      : null;
  const crewsOf = (agent: AgentProfile) =>
    (groups.data ?? []).filter((group) =>
      group.members.some((member) => member.agentId === agent.id),
    );

  const counts = { working: 0, resting: 0, paused: 0, unknown: 0 } as Record<
    WakerStatus,
    number
  >;
  for (const agent of roster) counts[statusOf(agent)] += 1;

  const roles = [
    ...new Set(roster.map((agent) => agent.title.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));

  /** The roster's toolbar applied to one list: the search box and the 运行状态 / 角色 / 环境 filters. */
  const narrow = (
    list: readonly AgentProfile[],
    search: WakersSearch,
    query: string,
  ) => {
    const needle = query.trim().toLowerCase();
    return list.filter(
      (agent) =>
        (!needle ||
          [agent.name, agent.title, agent.roleDescription].some((field) =>
            field.toLowerCase().includes(needle),
          )) &&
        (!search.status || statusOf(agent) === search.status) &&
        (!search.role || agent.title.trim() === search.role) &&
        (!search.env ||
          (deviceLineOf(agent) ? "device" : "unbound") === search.env),
    );
  };

  /**
   * 排序 within one section. Absent: the section's own order (the roster's, with the 分身 first under
   * 你的). `sort` is stable, so equal ones keep their order.
   */
  const order = (
    list: readonly AgentProfile[],
    sort: WakerSort | undefined,
  ) => {
    const lastRunMs = (agent: AgentProfile) => {
      const at = stats?.byAgent.get(agent.id)?.lastRunAt;
      return at ? new Date(at).getTime() : Number.NEGATIVE_INFINITY;
    };
    const taskCount = (agent: AgentProfile) =>
      stats?.byAgent.get(agent.id)?.count ?? 0;
    switch (sort) {
      case "name":
        return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      case "recent":
        return [...list].sort((a, b) => lastRunMs(b) - lastRunMs(a));
      case "tasks":
        return [...list].sort((a, b) => taskCount(b) - taskCount(a));
      default:
        return [...list];
    }
  };

  return {
    agents,
    hidden,
    groups,
    running,
    attention,
    month,
    roster,
    pending,
    avatarAgentId,
    unconfiguredAvatar,
    attentionById,
    pausedIds,
    statusOf,
    statsOf,
    deviceLineOf,
    crewsOf,
    counts,
    roles,
    narrow,
    order,
  };
}

export type RosterFacts = ReturnType<typeof useRosterFacts>;
