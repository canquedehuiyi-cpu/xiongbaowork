import {
  type Icon,
  IconLayoutGrid,
  IconMessageCircle,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isUnread } from "@/components/app-sidebar/roster";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { BrandLogo } from "@/components/layout/brand-logo";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import type { Rail } from "@/lib/navigation";

/** 入口栏上四个入口的名字，界面上照这个写。 */
export const RAIL_LABELS: Record<Rail, string> = {
  msg: "消息",
  contacts: "通讯录",
  work: "工作台",
  me: "我",
};

/*
 * 设计稿 `.rail button`：54px 宽，图标 22px 在上、11px 的字在下，安静的灰；选中的那个变亮、铺一层
 * 很淡的底，图标换成主色，左边一根 3px 的渐变竖条。
 */
const railButtonClassName =
  "relative grid w-[54px] cursor-pointer justify-items-center gap-1 rounded-(--wb-radius) border-0 bg-transparent pt-2 pb-[7px] text-[11px] text-(--wb-muted) outline-none transition-colors hover:text-(--wb-fg2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--wb-accent) aria-pressed:bg-(--wb-glass) aria-pressed:text-(--wb-fg) aria-pressed:before:absolute aria-pressed:before:top-3 aria-pressed:before:bottom-3 aria-pressed:before:-left-[7px] aria-pressed:before:w-[3px] aria-pressed:before:rounded-[3px] aria-pressed:before:bg-(image:--wb-me) aria-pressed:before:content-[''] [&>svg]:size-[22px] [&>svg]:stroke-[1.8] aria-pressed:[&>svg]:text-(--wb-accent)";

function RailButton({
  rail,
  selected,
  onSelect,
  children,
  describedBy,
}: {
  rail: Rail;
  selected: boolean;
  onSelect: (rail: Rail) => void;
  children: ReactNode;
  describedBy?: string;
}) {
  return (
    <button
      aria-describedby={describedBy}
      aria-label={RAIL_LABELS[rail]}
      aria-pressed={selected}
      className={railButtonClassName}
      data-rail={rail}
      onClick={() => onSelect(rail)}
      type="button"
    >
      {children}
    </button>
  );
}

const RAIL_ICONS: Record<Exclude<Rail, "me">, Icon> = {
  msg: IconMessageCircle,
  contacts: IconUsers,
  work: IconLayoutGrid,
};

/** 加载到的会话里有几段未读（打开着的那段不算），和侧栏会话行上的未读点是同一个判断。 */
function useUnreadCount(): number {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const openChannelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  return (channels.data ?? []).filter((channel) =>
    isUnread(channel, openChannelId),
  ).length;
}

/** 名字（没有名字时是邮箱）的第一个字，「我」入口上的头像就画它。 */
export function initialOf(name: string | null | undefined, email?: string) {
  const source = name?.trim() || email?.trim() || "";
  const first = Array.from(source)[0] ?? "";
  return first.toUpperCase();
}

/**
 * 工作台最左边的入口栏：熊宝的标，「消息」「通讯录」「工作台」，底部是「我」（画这个人名字的第一个字）。
 *
 * 选中哪个入口由外壳决定（跟着地址走，点一下可以先切过去看列表），这里只画和上报。「消息」上的角标是
 * 未读会话数；「通讯录」上挂着员工那里等你处理的事（`BotsNavBadge`，它同时负责发浏览器通知，所以整个应用
 * 只挂这一个）。
 */
export function WorkbenchRail({
  rail,
  onSelect,
}: {
  rail: Rail;
  onSelect: (rail: Rail) => void;
}) {
  const unread = useUnreadCount();
  const user = useQuery(currentUserQueryOptions()).data;
  const unreadId = "workbench-rail-unread";
  return (
    <nav
      aria-label="入口"
      className="flex min-h-0 flex-col items-center gap-1 border-(--wb-line) border-r bg-(--wb-rail) pt-4 pb-[14px] text-(--wb-muted)"
      data-workbench-rail
    >
      <Link
        aria-label={`${appConfig.brand.productName}首页`}
        className="mb-[14px] grid size-10 shrink-0 place-items-center rounded-(--wb-radius) shadow-(--wb-logo-shadow) outline-none focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
        to="/"
      >
        <BrandLogo className="rounded-(--wb-radius)" size={40} />
      </Link>
      {(["msg", "contacts", "work"] as const).map((id) => {
        const Glyph = RAIL_ICONS[id];
        return (
          <RailButton
            describedBy={id === "msg" && unread > 0 ? unreadId : undefined}
            key={id}
            onSelect={onSelect}
            rail={id}
            selected={rail === id}
          >
            <Glyph aria-hidden="true" />
            {RAIL_LABELS[id]}
            {id === "msg" && unread > 0 ? (
              <span
                className="absolute top-[3px] right-[9px] h-4 min-w-4 rounded-(--wb-radius-pill) bg-(--wb-accent) px-1 font-semibold text-[10px] text-white leading-4 tabular-nums shadow-[0_0_0_2px_var(--wb-rail)]"
                data-testid="workbench-unread"
              >
                <span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
                <span className="sr-only" id={unreadId}>
                  {unread} 段会话未读
                </span>
              </span>
            ) : null}
            {id === "contacts" ? (
              <span className="pointer-events-none absolute top-[3px] right-[9px] flex">
                <BotsNavBadge />
              </span>
            ) : null}
          </RailButton>
        );
      })}
      <div className="flex-1" />
      <RailButton onSelect={onSelect} rail="me" selected={rail === "me"}>
        <span
          aria-hidden="true"
          className="grid size-[34px] place-items-center rounded-full bg-(image:--wb-me-avatar) font-semibold text-(--wb-fg) text-[13px]"
          data-testid="workbench-me-initial"
        >
          {initialOf(user?.name, user?.email)}
        </span>
        {RAIL_LABELS.me}
      </RailButton>
    </nav>
  );
}
