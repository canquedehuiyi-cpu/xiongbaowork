import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
  type HeartbeatSettings,
} from "../../../../shared/heartbeat";

export type { HeartbeatSettings };

/** 一次真的醒来过的记录：没事静默、做了事、出了错，或还在跑。 */
export type HeartbeatOutcome = "running" | "quiet" | "acted" | "failed";

export type HeartbeatRun = {
  id: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: HeartbeatOutcome;
  /** 这次醒来在看板上自己领了几张卡。 */
  cardsClaimed: number;
  error: string | null;
};

/** `GET /api/agents/:id/heartbeat`：设置，加最近几次醒来。 */
export type HeartbeatRead = {
  heartbeat: HeartbeatSettings;
  recent: HeartbeatRun[];
};

export const heartbeatKeys = {
  all: ["heartbeat"] as const,
  detail: (agentId: string) => ["heartbeat", "detail", agentId] as const,
};

const OUTCOMES: readonly HeartbeatOutcome[] = [
  "running",
  "quiet",
  "acted",
  "failed",
];

/** 服务器答的是什么形状都不抛：缺的和坏的项用默认。 */
export function heartbeatFrom(value: unknown): HeartbeatRead {
  const body =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const raw =
    body.heartbeat && typeof body.heartbeat === "object"
      ? (body.heartbeat as Record<string, unknown>)
      : {};
  const interval = raw.intervalMinutes;
  const recent = Array.isArray(body.recent) ? body.recent : [];
  return {
    heartbeat: {
      enabled: raw.enabled === true,
      intervalMinutes:
        typeof interval === "number" && Number.isInteger(interval)
          ? interval
          : HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
      checklist: typeof raw.checklist === "string" ? raw.checklist : "",
    },
    recent: recent
      .filter(
        (run): run is Record<string, unknown> =>
          Boolean(run) && typeof run === "object",
      )
      .map((run) => ({
        id: String(run.id ?? ""),
        scheduledFor: String(run.scheduledFor ?? ""),
        startedAt: String(run.startedAt ?? ""),
        finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
        outcome: OUTCOMES.includes(run.outcome as HeartbeatOutcome)
          ? (run.outcome as HeartbeatOutcome)
          : "failed",
        cardsClaimed:
          typeof run.cardsClaimed === "number" ? run.cardsClaimed : 0,
        error: typeof run.error === "string" ? run.error : null,
      })),
  };
}

export function heartbeatQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: heartbeatKeys.detail(agentId),
    queryFn: async ({ signal }): Promise<HeartbeatRead> =>
      heartbeatFrom(
        await (
          await client(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
            signal,
            fallback: "读不到这位员工的心跳设置",
          })
        ).json(),
      ),
  });
}
