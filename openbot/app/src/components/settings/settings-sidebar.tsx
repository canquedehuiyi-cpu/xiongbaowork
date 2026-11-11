import {
  IconArrowLeft,
  IconBell,
  IconBook,
  IconBrowser,
  IconChecks,
  IconDeviceDesktop,
  IconDevices,
  IconGauge,
  IconHistory,
  IconKey,
  IconLayoutGrid,
  IconListCheck,
  IconLock,
  IconSchool,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { managePaths } from "@/lib/manage-paths";
import { mayOpenSetup, setupChecklistQueryOptions } from "@/lib/setup/queries";

type SettingsSidebarItem = {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  /** Shown only inside OpenBot Desktop, which is what the page reads from. */
  desktopOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
  /** The setup checklist: shown only to who may open it, with the count of what waits on them. */
  setup?: boolean;
};

/*
 * M5b：分区照上游 main 的设置侧栏，加上熊宝自己的「套餐与用量」「我的设备」。「已连接的账号」不在这里了，
 * 它和员工可用的连接器一起放在主导航的「连接」；@Waker 留在主导航，不进设置。
 */
export const SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    title: "通用",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /* Where updates go for every employee at once, and whether they check in; how much each sends is on its own page. */
    title: "通知",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    /* Whether employees ask first, rules for all of them, and what is waiting on you. Team settings are an administrator's. */
    title: "审批",
    icon: IconChecks,
    linkOptions: { to: "/settings/approvals" },
  },
  {
    /* The account's plan and this month's usage; `/plans` still lands here, for the server's `upgradeUrl`. */
    title: "套餐与用量",
    icon: IconGauge,
    linkOptions: { to: "/settings/plans" },
  },
  {
    /* Machines paired to run employees for you. Paired once, then left alone. */
    title: "我的设备",
    icon: IconDevices,
    linkOptions: { to: "/settings/devices" },
  },
  {
    /* The browsers signed in to the Recorder extension as you; each can be disconnected here. */
    title: "浏览器",
    icon: IconBrowser,
    linkOptions: { to: "/settings/browsers" },
  },
  {
    /* Who else's Bots use the Skills learned from your recordings: none, all, or the ones you open. */
    title: "学习",
    icon: IconSchool,
    linkOptions: { to: "/settings/learning" },
  },
  {
    /* What the deployment has and still needs: onboarding's checklist, to come back to. */
    title: "部署设置",
    icon: IconListCheck,
    linkOptions: { to: "/settings/setup" },
    setup: true,
  },
  {
    /* Logins saved from a Bot's private sign-in form. */
    title: "密码",
    icon: IconKey,
    linkOptions: { to: "/settings/passwords" },
  },
  {
    /* What OpenBot runs here and the memory it takes, with Restart and Stop. */
    title: "本机",
    icon: IconDeviceDesktop,
    desktopOnly: true,
    linkOptions: { to: "/settings/this-computer" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "组件展示",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

/**
 * What the personal edition keeps of Admin (upstream main): there is no Admin there, and the one
 * person still stores keys, writes skills, resets the computer and reads the trail. The pages live
 * under `settings/_personal`, whose guard sends the team edition back to Settings.
 */
const PERSONAL_SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    title: "密钥",
    icon: IconLock,
    linkOptions: { to: "/settings/credentials" },
  },
  {
    title: "技能",
    icon: IconBook,
    linkOptions: { to: "/settings/skills" },
  },
  {
    title: "电脑",
    icon: IconDeviceDesktop,
    linkOptions: { to: "/settings/computer" },
  },
  {
    title: managePaths("personal").auditLabel,
    icon: IconHistory,
    linkOptions: { to: "/settings/activity" },
  },
];

/** The entries for an edition: the personal one calls 密码 已保存的登录, as Connections does, and adds its own. */
export function settingsSidebarItems(
  edition: "team" | "personal",
): SettingsSidebarItem[] {
  return edition === "personal"
    ? [
        ...SETTINGS_SIDEBAR_ITEMS.map((item) =>
          item.title === "密码" ? { ...item, title: "已保存的登录" } : item,
        ),
        ...PERSONAL_SETTINGS_SIDEBAR_ITEMS,
      ]
    : SETTINGS_SIDEBAR_ITEMS;
}

/** The app sidebar's row, at the settings column's 13px. */
const rowClassName =
  "flex h-[37px] items-center gap-[10px] rounded-[9px] border border-transparent px-[11px] text-[13px] text-muted-foreground outline-none hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[status=active]:border-foreground/[0.06] data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground after:ml-auto after:hidden after:h-[12px] after:w-[4px] after:shrink-0 after:rounded-[3px] after:bg-signal after:content-[''] data-[status=active]:after:block [&>svg]:size-[16px] [&>svg]:shrink-0";

/**
 * Settings' own column (description (7) of the parity brief): ~245px on the card surface, between
 * the app sidebar — which stays — and the settings page. 「← 返回」 on top, then this product's
 * settings entries in the app sidebar's row style.
 */
export function SettingsNav() {
  const user = useQuery(currentUserQueryOptions()).data;
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions()).data;
  const canSetUp = mayOpenSetup(user, capabilities);
  /*
   * What an admin can act on, counted beside the setup entry: rows that need setup and say how.
   * Onboarding leaves the checklist out, so this is where an admin learns something is waiting on
   * them. Never asked for anybody else, who could not fix any of it.
   */
  const checklist = useQuery({
    ...setupChecklistQueryOptions(),
    enabled: canSetUp,
  }).data;
  const toFix =
    checklist?.audience === "admin"
      ? checklist.rows.filter(
          (row) => row.status === "needs_setup" && row.fix !== null,
        ).length
      : 0;
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
      {settingsSidebarItems(capabilities?.edition ?? "team").filter(
        (option) =>
          (!option.setup || canSetUp) &&
          (!option.desktopOnly || desktopShell() !== null),
      ).map((option) => (
        <Link
          {...option.linkOptions}
          activeOptions={{ exact: option.exact ?? false }}
          className={rowClassName}
          key={option.title}
        >
          <option.icon />
          {option.title}
          {option.setup && toFix > 0 ? (
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
      ))}
    </nav>
  );
}
