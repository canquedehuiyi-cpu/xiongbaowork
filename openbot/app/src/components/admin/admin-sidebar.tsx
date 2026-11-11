import {
  IconArrowLeft,
  IconBrain,
  IconBuildingBank,
  IconBulb,
  IconCode,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconLockAccess,
  IconPuzzle,
  IconRadar,
  IconShieldCheck,
  IconSlash,
  IconUsers,
  IconZoomQuestion,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same four groups, in the same order, as the admin index.
 *
 * A rail that lists ten things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same ten links is worse than either ordering.
 */
const GROUPS: {
  label: string;
  items: {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    label: "员工能碰到什么",
    items: [
      {
        title: "凭据",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "边界规则",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "电脑",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: "员工能做什么",
    items: [
      {
        title: "插件",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "模型提供方",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
      {
        title: "技能",
        icon: IconSlash,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "自动学习",
        icon: IconBulb,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: "主动巡检",
        icon: IconRadar,
        linkOptions: { to: "/admin/proactive" },
      },
      {
        title: "界面组件",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "试验台",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: "谁能进来",
    items: [
      {
        title: "成员",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "权限",
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
      },
      {
        title: "身份提供方",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    label: "发生过什么",
    items: [
      {
        title: "审计",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
      {
        title: "What would happen",
        icon: IconZoomQuestion,
        linkOptions: { to: "/admin/what-if" },
      },
    ],
  },
];

/*
 * The same row language as the app sidebar (docs/design/ios-studio): 37px rows, quiet grey, and the
 * open page on a faint plate with a hairline and a red 4×12 bar at its right end.
 */
const ADMIN_ROW =
  "h-[37px] rounded-[9px] border border-transparent px-[11px] text-[13px] text-muted-foreground hover:bg-foreground/[0.03] hover:text-sidebar-foreground";
const ADMIN_ACTIVE =
  "border-foreground/[0.06] bg-sidebar-accent font-medium text-sidebar-accent-foreground after:ml-auto after:h-[12px] after:w-[4px] after:shrink-0 after:rounded-[3px] after:bg-signal after:content-['']";

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" {...props}>
      {/*
       * Pinned to the same height as the app sidebar's header. Left to itself this one is 60px
       * against the app's 45px — `p-2` around a `size="lg"` button rather than a fixed height — so
       * the nav list started lower here and the sidebar appeared to shift on the way into Admin.
       *
       * The button takes its default height rather than `h-full`. `h-full` resolves against the
       * parent, which in the app sidebar is a flex row holding a second control and here is not, so
       * the same class produces two different heights.
       */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  返回应用
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
               * `activeOptions.exact`, because /admin is a prefix of every other route here and
               * would otherwise light up on all of them.
               */}
              <SidebarMenuButton
                className={ADMIN_ROW}
                render={(props) => (
                  <Link
                    {...adminLinkOptions}
                    activeOptions={{ exact: true }}
                    activeProps={{ className: ADMIN_ACTIVE }}
                    {...props}
                  >
                    概览
                  </Link>
                )}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-px">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    className={ADMIN_ROW}
                    render={(props) => (
                      <Link
                        {...item.linkOptions}
                        activeProps={{ className: ADMIN_ACTIVE }}
                        {...props}
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
