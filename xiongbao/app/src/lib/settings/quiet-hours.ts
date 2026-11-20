import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  DEFAULT_QUIET_HOURS,
  type QuietHours,
} from "../../../../shared/user-preferences";
import { settingsKeys } from "./queries";

/**
 * 安静时段（期 3·3.2）：员工在这段时间里不主动找你、不推送，推迟到结束再做。读写
 * `/api/settings/preferences/quiet-hours`，信封是 `{quietHours: {enabled, start, end, timeZone}}`；时区是作息里存的那个。
 */
export type { QuietHours };

export type QuietHoursSetting = QuietHours & { timeZone: string };

export const QUIET_HOURS_PATH = "/api/settings/preferences/quiet-hours";

export const quietHoursKey = (userId: string | undefined) =>
  [...settingsKeys.all, "quiet-hours", userId] as const;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 服务器答的是什么形状都不抛：缺的和坏的项用默认，和服务器读存下来的值是同一条规则。 */
export function quietHoursFrom(value: unknown): QuietHoursSetting {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled:
      typeof saved.enabled === "boolean"
        ? saved.enabled
        : DEFAULT_QUIET_HOURS.enabled,
    start:
      typeof saved.start === "string" && CLOCK.test(saved.start)
        ? saved.start
        : DEFAULT_QUIET_HOURS.start,
    end:
      typeof saved.end === "string" && CLOCK.test(saved.end)
        ? saved.end
        : DEFAULT_QUIET_HOURS.end,
    timeZone: typeof saved.timeZone === "string" ? saved.timeZone : "",
  };
}

export function quietHoursQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: quietHoursKey(userId),
    enabled: Boolean(userId),
    queryFn: async ({ signal }): Promise<QuietHoursSetting> =>
      quietHoursFrom(
        await client<unknown>(QUIET_HOURS_PATH, "quietHours", {
          signal,
          fallback: "读不到你的安静时段",
        }),
      ),
  });
}

/** 改其中一项或几项，没提到的保持原样。 */
export function saveQuietHoursMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  return mutationOptions({
    mutationFn: async (
      patch: Partial<QuietHours>,
    ): Promise<QuietHoursSetting> => {
      if (!userId) throw new Error("登录后才能保存安静时段。");
      return quietHoursFrom(
        await client<unknown>(QUIET_HOURS_PATH, "quietHours", {
          method: "PATCH",
          body: patch,
          fallback: "安静时段没能保存，请稍后再试。",
        }),
      );
    },
    onSuccess: (saved) =>
      queryClient.setQueryData(quietHoursKey(userId), saved),
  });
}
