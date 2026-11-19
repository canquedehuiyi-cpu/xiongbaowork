import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  DEFAULT_RUN_END_NOTICE,
  RUN_END_NOTICE_CHANNELS,
  type RunEndNoticePreferences,
} from "../../../../shared/user-preferences";
import { settingsKeys } from "./queries";

/**
 * 员工跑完通知（期九·五）：手机推送、绑定的聊天应用、开着的网页和桌面版的系统通知，三个开关，默认全开。
 * 读写 `/api/settings/preferences/run-notice`，信封是 `{runNotice: {push, im, desktop}}`。
 */
export type { RunEndNoticePreferences };

export const RUN_NOTICE_PATH = "/api/settings/preferences/run-notice";

export const runNoticeKey = (userId: string | undefined) =>
  [...settingsKeys.all, "run-notice", userId] as const;

/** 服务器答的是什么形状都不抛：不是 `false` 的一律当开着，和服务器读存下来的值是同一条规则。 */
export function runNoticeFrom(value: unknown): RunEndNoticePreferences {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const notice = { ...DEFAULT_RUN_END_NOTICE };
  for (const channel of RUN_END_NOTICE_CHANNELS)
    if (saved[channel] === false) notice[channel] = false;
  return notice;
}

export function runNoticeQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: runNoticeKey(userId),
    enabled: Boolean(userId),
    queryFn: async ({ signal }): Promise<RunEndNoticePreferences> =>
      runNoticeFrom(
        await client<unknown>(RUN_NOTICE_PATH, "runNotice", {
          signal,
          fallback: "读不到你的跑完通知设置",
        }),
      ),
  });
}

/** 改其中一个或几个开关，没提到的保持原样。 */
export function saveRunNoticeMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  const queryKey = runNoticeKey(userId);
  return mutationOptions({
    mutationFn: async (
      patch: Partial<RunEndNoticePreferences>,
    ): Promise<RunEndNoticePreferences> => {
      if (!userId) throw new Error("登录后才能保存通知设置。");
      return runNoticeFrom(
        await client<unknown>(RUN_NOTICE_PATH, "runNotice", {
          method: "PATCH",
          body: patch,
          fallback: "跑完通知的设置没能保存",
        }),
      );
    },
    onSuccess: (notice) => queryClient.setQueryData(queryKey, notice),
  });
}
