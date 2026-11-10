import {
  IconArrowLeft,
  IconBell,
  IconBrowser,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListCheck,
  IconPlug,
  IconSchool,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
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
 * M4: 待接入 上游设置里的「通知」（/settings/notifications）和「审批」（/settings/approvals）两页，
 * fork 目前没有这两个路由，等页面接进来再加入口。
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
    /* Where upstream has it, after 通用. Whether your employees check in for you, for all of them; where updates reach you is linked. */
    title: "通知",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    /*
     * The same subject as Admin's Plugins, from the other side: there an administrator decides what
     * this deployment may reach at all, here you decide what it may reach as you.
     */
    title: "已连接的账号",
    icon: IconPlug,
    linkOptions: { to: "/settings/connected-accounts" },
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
      {SETTINGS_SIDEBAR_ITEMS.filter(
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
