import { IconBell, IconDeviceMobile, IconMessages } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import {
  type RunEndNoticePreferences,
  runNoticeQueryOptions,
  saveRunNoticeMutationOptions,
} from "@/lib/settings/run-notice";
import { queryClient } from "@/query-client";

/**
 * 「员工跑完通知」：员工在你不在对话页面上时跑完一轮（做完、出错、需要你、被中断），在哪里告诉你。三个开关各管
 * 一处，默认全开，只在你不在这段对话的页面上时才通知。
 */
const ROWS: readonly {
  key: keyof RunEndNoticePreferences;
  title: string;
  description: string;
  icon: ReactNode;
}[] = [
  {
    key: "push",
    title: "手机推送",
    description: "推到你装了 App 的手机，点开直接进这段对话。",
    icon: <IconDeviceMobile />,
  },
  {
    key: "im",
    title: "微信等聊天应用",
    description: "发到你已经绑定的聊天应用里，按那个渠道自己的设置推送。",
    icon: <IconMessages />,
  },
  {
    key: "desktop",
    title: "网页和桌面版的系统通知",
    description: `开着${shortName()}的网页或桌面版，在页面不在前台时弹系统通知。`,
    icon: <IconBell />,
  },
];

export function RunNoticeSection() {
  const userId = useQuery(currentUserQueryOptions()).data?.id;
  const notice = useQuery(runNoticeQueryOptions(userId));
  const save = useMutation(saveRunNoticeMutationOptions(queryClient, userId));
  return (
    <PageSection
      description="员工在你不在这段对话的页面上时跑完一轮（做完、出错、需要你、被中断），会在这里选的地方告诉你。"
      title="员工跑完通知"
    >
      {notice.isPending ? null : notice.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的跑完通知设置。请刷新页面。
        </p>
      ) : (
        <PageRows>
          {ROWS.map((row) => {
            // 开关跟着手指走，存好之前先画新的，存好以后以服务器存的为准。
            const pressed =
              save.isPending && save.variables
                ? save.variables[row.key]
                : undefined;
            const on = pressed ?? notice.data?.[row.key] ?? true;
            return (
              <Item key={row.key} size="sm">
                <ItemMedia variant="icon">{row.icon}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{row.title}</ItemTitle>
                  <ItemDescription>{row.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={`${row.title}：员工跑完时通知我`}
                    checked={on}
                    disabled={save.isPending}
                    onCheckedChange={(next) => save.mutate({ [row.key]: next })}
                  />
                </ItemActions>
              </Item>
            );
          })}
        </PageRows>
      )}
      {save.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
