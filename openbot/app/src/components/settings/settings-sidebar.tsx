import {
  IconArrowLeft,
  IconKey,
  IconLayoutGrid,
  IconPlug,
  IconSettings,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";

const ITEMS: {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
}[] = [
  {
    title: "通用",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
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
    /* Logins saved from a Bot's private sign-in form. */
    title: "密码",
    icon: IconKey,
    linkOptions: { to: "/settings/passwords" },
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
      {ITEMS.map((option) => (
        <Link
          {...option.linkOptions}
          activeOptions={{ exact: option.exact ?? false }}
          className={rowClassName}
          key={option.title}
        >
          <option.icon />
          {option.title}
        </Link>
      ))}
    </nav>
  );
}
