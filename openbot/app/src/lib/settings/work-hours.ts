import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { UserPreferences } from "../../../../shared/user-preferences";
import { client } from "../client";
import { browserTimeZone } from "../routines/form";
import {
  userPreferencesQueryOptions,
  useUserPreferences,
} from "./message-list";

/*
 * 作息（规格 `docs/specs/2026-11-15-delivery-loop.md` 第 10 节）：开工、收工时间，时区，周末发不发。存在
 * 服务器的偏好里（`GET / PATCH /api/settings/preferences` 的 `workHours`，`server/src/user-preferences.ts`），
 * 服务器按它推清点、决定作息外不推送、不催员工。
 */

/** 服务器回的作息；老服务端不带时没有。 */
export type WorkHours = {
  /** "HH:MM"。 */
  start: string;
  /** "HH:MM"，晚于开工。 */
  end: string;
  /** IANA 时区，如 "Asia/Shanghai"。 */
  timeZone: string;
  /** 周六、周日发不发。 */
  weekends: boolean;
};

/** 偏好接口回的全部：共享的那几项，加上作息。 */
export type PreferencesWithWorkHours = UserPreferences & {
  workHours?: WorkHours;
};

/** 服务器的默认作息（`DEFAULT_WORK_HOURS`），读到之前或老服务端时用来回显。 */
export const DEFAULT_WORK_HOURS = {
  start: "09:00",
  end: "18:00",
  weekends: false,
} as const;

/** 这个人的作息；读到之前、读不到或老服务端为 undefined。 */
export function useWorkHours(): WorkHours | undefined {
  return (useUserPreferences().data as PreferencesWithWorkHours | undefined)
    ?.workHours;
}

/** 按谁的时区算「此刻几点」：作息里存的，取不到退回浏览器的。 */
export function scheduleTimeZone(hours: WorkHours | undefined): string {
  return hours?.timeZone || browserTimeZone();
}

/** 「09:00–18:00」，周末也发时加「，周末也发」。 */
export function workHoursText(hours: WorkHours): string {
  return `${hours.start}–${hours.end}${hours.weekends ? "，周末也发" : ""}`;
}

/** 开工要早于收工（同一天内）：服务器同样这样查，在这里先拦住。 */
export function isWorkStretch(start: string, end: string): boolean {
  return /^\d\d:\d\d$/.test(start) && /^\d\d:\d\d$/.test(end) && start < end;
}

/**
 * 一次作息保存：改了的那几项（`workHours`），或者只是告诉服务器浏览器在哪个时区（`browserTimeZone`：服务器
 * 只在还没存过时区时把它记下，存过的不改）。回来的偏好直接放进缓存。
 */
export type WorkHoursSave =
  | { workHours: Partial<WorkHours> }
  | { browserTimeZone: string };

export function saveWorkHoursMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  return mutationOptions({
    mutationFn: (save: WorkHoursSave): Promise<PreferencesWithWorkHours> => {
      if (!userId) throw new Error("登录后才能保存作息。");
      return client("/api/settings/preferences", "preferences", {
        method: "PATCH",
        body: save,
        fallback: "作息没能保存，请稍后再试。",
      });
    },
    onSuccess: (preferences) =>
      queryClient.setQueryData(
        userPreferencesQueryOptions(userId).queryKey,
        preferences,
      ),
  });
}
