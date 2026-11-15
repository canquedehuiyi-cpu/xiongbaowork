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
import { cn } from "@/lib/utils";

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

/*
 * 手机上的底部标签栏（像微信）：四个入口平分一行，图标 24px 在上、11px 的字在下；选中的那个图标和字都换成
 * 主色，不铺底、不画竖条。
 */
const tabButtonClassName =
  "relative grid min-w-0 flex-1 cursor-pointer justify-items-center gap-0.5 rounded-(--wb-radius) border-0 bg-transparent pt-1.5 pb-1 text-[11px] text-(--wb-muted) outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--wb-accent) aria-pressed:text-(--wb-accent) [&>svg]:size-6 [&>svg]:stroke-[1.8]";

/** 入口栏还是底部标签栏：桌面是前者，宽度不足 768px 时是后者。 */
export type RailLayout = "rail" | "tabs";

function RailButton({
  rail,
  selected,
  onSelect,
  children,
  describedBy,
  layout,
}: {
  rail: Rail;
  selected: boolean;
  onSelect: (rail: Rail) => void;
  children: ReactNode;
  describedBy?: string;
  layout: RailLayout;
}) {
  return (
    <button
      aria-describedby={describedBy}
      aria-label={RAIL_LABELS[rail]}
      aria-pressed={selected}
      className={layout === "tabs" ? tabButtonClassName : railButtonClassName}
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
 *
 * 手机上（`layout="tabs"`）它是屏幕底部的标签栏：没有熊宝的标，四个入口平分一行，底下让出系统的安全区。
 * 进了对话这类详情页，外壳用 `hidden` 把它收起而不是拿掉，角标和浏览器通知照常工作。
 */
export function WorkbenchRail({
  rail,
  onSelect,
  layout = "rail",
  hidden = false,
  inert = false,
}: {
  rail: Rail;
  onSelect: (rail: Rail) => void;
  layout?: RailLayout;
  hidden?: boolean;
  /** 手机上名片盖住整屏时，标签栏点不到。 */
  inert?: boolean;
}) {
  const unread = useUnreadCount();
  const user = useQuery(currentUserQueryOptions()).data;
  const unreadId = "workbench-rail-unread";
  const tabs = layout === "tabs";
  const badgeClassName = tabs
    ? "top-0.5 left-1/2 ml-[5px]"
    : "top-[3px] right-[9px]";
  return (
    <nav
      aria-label="入口"
      className={
        tabs
          ? "order-last flex shrink-0 items-stretch border-(--wb-line) border-t bg-(--wb-rail) px-1 pt-0.5 pb-[calc(2px+env(safe-area-inset-bottom))] text-(--wb-muted)"
          : "flex min-h-0 flex-col items-center gap-1 border-(--wb-line) border-r bg-(--wb-rail) pt-4 pb-[14px] text-(--wb-muted)"
      }
      data-workbench-rail
      data-workbench-tabbar={tabs ? "" : undefined}
      hidden={hidden}
      inert={inert}
    >
      {tabs ? null : (
        <Link
          aria-label={`${appConfig.brand.productName}首页`}
          className="mb-[14px] grid size-10 shrink-0 place-items-center rounded-(--wb-radius) shadow-(--wb-logo-shadow) outline-none focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
          to="/"
        >
          <BrandLogo className="rounded-(--wb-radius)" size={40} />
        </Link>
      )}
      {(["msg", "contacts", "work"] as const).map((id) => {
        const Glyph = RAIL_ICONS[id];
        return (
          <RailButton
            describedBy={id === "msg" && unread > 0 ? unreadId : undefined}
            key={id}
            layout={layout}
            onSelect={onSelect}
            rail={id}
            selected={rail === id}
          >
            <Glyph aria-hidden="true" />
            {RAIL_LABELS[id]}
            {id === "msg" && unread > 0 ? (
              <span
                className={cn(
                  "absolute h-4 min-w-4 rounded-(--wb-radius-pill) bg-(--wb-accent) px-1 font-semibold text-[10px] text-white leading-4 tabular-nums shadow-[0_0_0_2px_var(--wb-rail)]",
                  badgeClassName,
                )}
                data-testid="workbench-unread"
              >
                <span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
                <span className="sr-only" id={unreadId}>
                  {unread} 段会话未读
                </span>
              </span>
            ) : null}
            {id === "contacts" ? (
              <span
                className={cn(
                  "pointer-events-none absolute flex",
                  badgeClassName,
                )}
              >
                <BotsNavBadge />
              </span>
            ) : null}
          </RailButton>
        );
      })}
      {tabs ? null : <div className="flex-1" />}
      <RailButton
        layout={layout}
        onSelect={onSelect}
        rail="me"
        selected={rail === "me"}
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid place-items-center rounded-full bg-(image:--wb-me-avatar) font-semibold text-(--wb-fg)",
            tabs ? "size-6 text-[11px]" : "size-[34px] text-[13px]",
          )}
          data-testid="workbench-me-initial"
        >
          {initialOf(user?.name, user?.email)}
        </span>
        {RAIL_LABELS.me}
      </RailButton>
    </nav>
  );
}
