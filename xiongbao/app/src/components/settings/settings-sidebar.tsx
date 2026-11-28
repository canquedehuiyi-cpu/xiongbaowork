import {
  IconArrowLeft,
  IconBell,
  IconBook,
  IconChecks,
  IconDevices,
  IconHistory,
  IconKey,
  IconLayoutGrid,
  IconLink,
  IconLock,
  IconSchool,
  IconSettings,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Link, type LinkOptions, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { managePaths } from "@/lib/manage-paths";
import {
  type SectionAudience,
  type SettingsAudience,
  shows,
  useSettingsAudience,
} from "@/lib/settings/audience";
import { useSetupToFix } from "@/lib/setup/queries";

export type SettingsTopic = {
  id:
    | "account"
    | "models"
    | "approvals"
    | "connections"
    | "devices"
    | "notifications"
    | "team";
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  /** 除自己地址外还归它亮的地址前缀（同 NAVIGATION.owns）；account 的 "/settings" 精确匹配 */
  owns?: readonly string[];
  audience?: SectionAudience;
  /** 部署设置待办数挂在这一项上 */
  setupBadge?: boolean;
};

/*
 * 七个话题照设计稿 §5.2。未完成的话题暂时仍指旧页（§9）：员工与模型 → /capabilities/models，
 * 连接与技能 → /connections，团队管理 → /admin；搬完一个话题就把它的地址改到新页。
 */
const TOPICS: SettingsTopic[] = [
  {
    id: "account",
    title: "账户与外观",
    icon: IconSettings,
    linkOptions: { to: "/settings" },
    /*
     * 部署设置过渡期归账户与外观，所有能打开它的人一样（团队版管理员也是），待办数也挂在这里：
     * 团队管理现在指向 /admin，那一页没有部署设置的入口。任务 27 把它挪到团队管理（设计稿 §5.3.1）。
     */
    owns: ["/settings/plans", "/settings/about", "/settings/setup"],
    setupBadge: true,
  },
  {
    id: "models",
    title: "员工与模型",
    icon: IconSparkles,
    linkOptions: { to: "/capabilities/models" },
    owns: ["/settings/models"],
  },
  {
    id: "approvals",
    title: "审批与安全",
    icon: IconChecks,
    linkOptions: { to: "/settings/approvals" },
  },
  {
    id: "connections",
    title: "连接与技能",
    icon: IconLink,
    linkOptions: { to: "/connections" },
    owns: ["/settings/connections"],
  },
  {
    id: "devices",
    title: "电脑与设备",
    icon: IconDevices,
    linkOptions: { to: "/settings/devices" },
    owns: ["/settings/computer"],
  },
  {
    id: "notifications",
    title: "主动与通知",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    id: "team",
    title: "团队管理",
    icon: IconUsersGroup,
    linkOptions: { to: "/admin" },
    owns: ["/settings/team"],
    audience: { who: "team-admin", edition: "team" },
  },
];

export function settingsTopics(audience: SettingsAudience): SettingsTopic[] {
  return TOPICS.filter((t) => !t.audience || shows(t.audience, audience));
}

type LegacyItem = {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions & { to: string };
  personalOnly?: boolean;
};

/*
 * 过渡分组：旧侧栏里还没搬走的项。每个 PR 搬走一项就删一项（任务 11 删活动、任务 20 删组件展示、
 * 任务 24 删技能、任务 25 删其余）。
 */
const LEGACY_TAIL: LegacyItem[] = [
  {
    title: "学习",
    icon: IconSchool,
    linkOptions: { to: "/settings/learning" },
  },
  { title: "密码", icon: IconKey, linkOptions: { to: "/settings/passwords" } },
  {
    title: "组件展示",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
  {
    title: "密钥",
    icon: IconLock,
    linkOptions: { to: "/settings/credentials" },
    personalOnly: true,
  },
  {
    title: "技能",
    icon: IconBook,
    linkOptions: { to: "/settings/skills" },
    personalOnly: true,
  },
  {
    title: managePaths("personal").auditLabel,
    icon: IconHistory,
    linkOptions: { to: "/settings/activity" },
    personalOnly: true,
  },
];

/** 过渡分组里这个受众看得到的项；个人版把「密码」叫「已保存的登录」，和连接页一致。 */
export function legacyTail(audience: SettingsAudience): LegacyItem[] {
  const personal = audience.edition === "personal";
  return LEGACY_TAIL.filter((item) => personal || !item.personalOnly).map(
    (item) =>
      personal && item.title === "密码"
        ? { ...item, title: "已保存的登录" }
        : item,
  );
}

const within = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** 打开 pathname 时亮哪一项：自己的地址或认领的前缀里最长的那个；"/settings" 只精确匹配。 */
export function activeTopic(
  topics: SettingsTopic[],
  pathname: string,
): SettingsTopic["id"] | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: { id: SettingsTopic["id"]; length: number } | null = null;
  for (const topic of topics) {
    const own = (topic.linkOptions as { to: string }).to;
    const prefixes = [own, ...(topic.owns ?? [])];
    for (const prefix of prefixes) {
      const hit =
        prefix === "/settings" ? path === prefix : within(path, prefix);
      if (hit && (!best || prefix.length > best.length))
        best = { id: topic.id, length: prefix.length };
    }
  }
  return best?.id ?? null;
}

/** The app sidebar's row, at the settings column's 13px. */
const rowClassName =
  "flex h-[37px] items-center gap-[10px] rounded-[9px] border border-transparent px-[11px] text-[13px] text-muted-foreground outline-none hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[status=active]:border-foreground/[0.06] data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground after:ml-auto after:hidden after:h-[12px] after:w-[4px] after:shrink-0 after:rounded-[3px] after:bg-signal after:content-[''] data-[status=active]:after:block [&>svg]:size-[16px] [&>svg]:shrink-0";

/**
 * Settings' own column (description (7) of the parity brief): ~245px on the card surface, between
 * the app sidebar — which stays — and the settings page. 「← 返回」 on top, then the seven topics
 * and, for what has not moved yet, a group of the old entries.
 */
export function SettingsNav() {
  const audience = useSettingsAudience();
  const toFix = useSetupToFix();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const topics = settingsTopics(audience);
  const active = activeTopic(topics, pathname);
  const tail = legacyTail(audience);
  return (
    <nav
      aria-label="设置导航"
      className="flex w-[148px] shrink-0 flex-col gap-[3px] overflow-y-auto border-border border-r bg-sidebar px-[8px] py-[12px] md:w-[226px] md:px-[15px]"
    >
      <Link
        activeOptions={{ exact: true }}
        activeProps={{}}
        className={`${rowClassName} mb-[8px] text-muted-foreground`}
        to="/"
      >
        <IconArrowLeft />
        返回
      </Link>
      {topics.map((topic) => {
        const isActive = active === topic.id;
        return (
          <Link
            {...topic.linkOptions}
            activeOptions={{ exact: true }}
            activeProps={{}}
            aria-current={isActive ? "page" : undefined}
            className={rowClassName}
            data-status={isActive ? "active" : undefined}
            inactiveProps={{}}
            key={topic.id}
          >
            <topic.icon />
            {topic.title}
            {topic.setupBadge && toFix > 0 ? (
              <>
                <span className="sr-only">，{toFix} 项待设置</span>
                <span
                  aria-hidden="true"
                  className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[11px] tabular-nums"
                >
                  {toFix}
                </span>
              </>
            ) : null}
          </Link>
        );
      })}
      {tail.length > 0 ? (
        <>
          <p className="mt-[10px] mb-[2px] px-[11px] text-[11px] text-muted-foreground">
            其他设置
          </p>
          {tail.map((item) => {
            const isActive = within(pathname, item.linkOptions.to);
            return (
              <Link
                {...item.linkOptions}
                activeOptions={{ exact: true }}
                activeProps={{}}
                aria-current={isActive ? "page" : undefined}
                className={rowClassName}
                data-status={isActive ? "active" : undefined}
                inactiveProps={{}}
                key={item.title}
              >
                <item.icon />
                {item.title}
              </Link>
            );
          })}
        </>
      ) : null}
    </nav>
  );
}
