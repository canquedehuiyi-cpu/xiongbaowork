import {
  mutationOptions,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  UserPreferences,
  WorkHours,
} from "../../../../shared/user-preferences";
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

/**
 * 服务器回的作息；老服务端不带时没有。
 *
 * 形状定义在 `shared/user-preferences`：`users.preferences` 那一列也按它声明，两边共用一个，免得一处加了字段另一处不知情。
 */
export type { WorkHours };

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

/**
 * 交付闭环里的时刻按哪个时区念：作息里的时区；作息还没读到（或老服务端不给）时为 undefined，各处按浏览器的
 * 钟念。
 */
export function useScheduleZone(): string | undefined {
  return useWorkHours()?.timeZone || undefined;
}

/** 时区的中文长名，如「中国标准时间」「北美中部标准时间」；认不出时没有。 */
export function zoneLongName(
  zone: string,
  at: Date = new Date(),
): string | undefined {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: zone,
      timeZoneName: "long",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}

/** 两个时区此刻的钟是不是一样（「Asia/Chongqing」和「Asia/Shanghai」名字不同、钟一样）。 */
export function sameClock(
  a: string,
  b: string,
  at: Date = new Date(),
): boolean {
  const read = (zone: string) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).format(at);
    } catch {
      return null;
    }
  };
  return read(a) === read(b);
}

/**
 * 作息时区和这台设备的钟不一样时，页面顶上那一行小字：「时间按你的作息时区（中国标准时间）显示」；一样时、
 * 作息还没读到时为 null。
 */
export function useZoneNote(at: Date = new Date()): string | null {
  const zone = useScheduleZone();
  if (!zone || sameClock(zone, browserTimeZone(), at)) return null;
  return `时间按你的作息时区（${zoneLongName(zone, at) ?? zone}）显示`;
}

/** 「09:00–18:00」，周末也发时加「，周末也发」。 */
export function workHoursText(hours: WorkHours): string {
  return `${hours.start}–${hours.end}${hours.weekends ? "，周末也发" : ""}`;
}

/** 开工要早于收工（同一天内）：服务器同样这样查，在这里先拦住。 */
export function isWorkStretch(start: string, end: string): boolean {
  return /^\d\d:\d\d$/.test(start) && /^\d\d:\d\d$/.test(end) && start < end;
}

/** 一次作息保存：改了的那几项。回来的偏好直接放进缓存。 */
export type WorkHoursSave = { workHours: Partial<WorkHours> };

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

/** 这次页面加载里已经把浏览器时区告诉过服务器的人：每人每次加载只试一次，失败了下次加载再试。 */
const toldBrowserZone = new Set<string>();

/**
 * 登录后把浏览器的时区告诉服务器（规格第 10 节「第一次登录或打开设置时由浏览器写入」）。服务器只在还没存过
 * 时区时记下它，存过的（你自己选的、或别的设备先写的）不改，所以每次加载发一次是安全的。
 *
 * 回包只改缓存里作息的时区，而且只在请求发出以后没人改过它时才改：这样作息设置页上正在填的值不会被冲掉，
 * 先发后到的回包也盖不掉刚保存的时区。挂在登录后的外壳上（`routes/_authed.tsx`），每个皮肤都一样。
 */
export function useTellBrowserTimeZone() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const userId = preferences.userId;
  const ready = preferences.isSuccess;
  useEffect(() => {
    if (!userId || !ready || toldBrowserZone.has(userId)) return;
    toldBrowserZone.add(userId);
    const key = userPreferencesQueryOptions(userId).queryKey;
    const zoneNow = () =>
      (queryClient.getQueryData(key) as PreferencesWithWorkHours | undefined)
        ?.workHours?.timeZone;
    const before = zoneNow();
    client<PreferencesWithWorkHours>(
      "/api/settings/preferences",
      "preferences",
      {
        method: "PATCH",
        body: { browserTimeZone: browserTimeZone() },
        fallback: "没能记下你的时区。",
      },
    )
      .then((stored) => {
        const zone = stored?.workHours?.timeZone;
        if (!zone || zoneNow() !== before) return;
        queryClient.setQueryData(key, (current) => {
          const hours = (current as PreferencesWithWorkHours | undefined)
            ?.workHours;
          return current && hours
            ? ({
                ...current,
                workHours: { ...hours, timeZone: zone },
              } as typeof current)
            : current;
        });
      })
      // 老服务端不认这个字段、或网络断了：这次不写，下次加载再试。
      .catch(() => {});
  }, [userId, ready, queryClient]);
}

/** 挂在登录后外壳上的那一个：什么都不画。 */
export function BrowserTimeZoneSync() {
  useTellBrowserTimeZone();
  return null;
}
