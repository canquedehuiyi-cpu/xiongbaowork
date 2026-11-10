import {
  type Icon,
  IconBoxSeam,
  IconPlug,
  IconSettings,
  IconShieldLock,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Where a person can go in OpenBot, in one list, for every skin that replaces the sidebar.
 *
 * A destination added here reaches every skin's frame at once. One left out of a frame's own copy
 * would simply be missing from that skin, with nothing failing to say so.
 *
 * `section` says where each entry belongs: `primary` destinations sit with the main places, `account`
 * ones in the menu under the person's name. A skin may group them its own way.
 *
 * The places are this fork's own pages, under the names its sidebar gives them: 员工管理 (`/wakers`),
 * 能力与资源 (`/resources`), and 已连接的账号 under Settings, where a person connects the apps a Bot
 * reaches as them. The ids stay the ones the skins switch on.
 */
export type NavigationItem = {
  id: "bots" | "capabilities" | "connections" | "admin" | "settings";
  label: string;
  to:
    | "/wakers"
    | "/resources"
    | "/settings/connected-accounts"
    | "/admin"
    | "/settings";
  icon: Icon;
  section: "primary" | "account";
  /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
  adminOnly?: boolean;
};

/** An entry that is a page. Every entry is one; kept so the skins can keep filtering on it. */
export type NavigationLink = NavigationItem;

export function isNavigationLink(item: NavigationItem): item is NavigationLink {
  return Boolean(item.to);
}

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "bots",
    label: "员工管理",
    to: "/wakers",
    icon: IconUsers,
    section: "primary",
  },
  {
    id: "capabilities",
    label: "能力与资源",
    to: "/resources",
    icon: IconBoxSeam,
    section: "primary",
  },
  {
    id: "connections",
    label: "已连接的账号",
    to: "/settings/connected-accounts",
    icon: IconPlug,
    section: "primary",
  },
  {
    id: "admin",
    label: "管理",
    to: "/admin",
    icon: IconShieldLock,
    section: "account",
    adminOnly: true,
  },
  {
    id: "settings",
    label: "设置",
    to: "/settings",
    icon: IconSettings,
    section: "account",
  },
];

/**
 * The destinations this person may open, in order. The personal edition has no Admin, since nobody
 * there administers anybody else.
 */
export function navigationFor(
  role: string | undefined,
  edition: "team" | "personal" = "team",
): readonly NavigationItem[] {
  if (edition === "personal") {
    return NAVIGATION.filter((item) => item.id !== "admin");
  }
  return NAVIGATION.filter((item) => !item.adminOnly || role === "admin");
}

/** `navigationFor` the signed-in person, on this deployment's edition. */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  return navigationFor(user?.role, capabilities?.edition ?? "team");
}
