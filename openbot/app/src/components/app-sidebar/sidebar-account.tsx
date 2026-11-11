import { IconBrightness, IconLanguage, IconLogout } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { OpenBotVersion } from "@/components/layout/openbot-version";
import { useOptionalTheme } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import {
  AVATAR_MENU_ITEM,
  isNavigationLink,
  useNavigationItems,
} from "@/lib/navigation";
import { planSummaryQueryOptions } from "@/lib/quota/queries";
import { useSignOut } from "./use-sign-out";

const menuItemClassName = "gap-2 px-2 py-1.5 text-[13px]";

function AccountAvatar({ label }: { label: string }) {
  const initials = label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden="true"
      className="flex size-[29px] shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-foreground/[0.13] bg-accent text-[12px] text-foreground/85 shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]"
    >
      {initials}
    </span>
  );
}

/**
 * 这个人自己的分身员工的 id，读自 `GET /api/me/avatar/sources` 的 `agentId`。读不到（还没有分身、
 * 服务端不答）时是 undefined，账户菜单就不画「我的分身」。分身不会换人，所以读一次就够。
 */
function useAvatarAgentId(): string | undefined {
  return useQuery({
    ...avatarSourcesQueryOptions(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data?.agentId;
}

/**
 * 侧栏最底下的账户行：头像、名字和服务端的版本号，点开向上弹出账户菜单——
 * 我的分身、套餐与用量（第二行写着现在的套餐）、设置、管理（仅管理员）、主题、语言、退出登录。
 *
 * 套餐、设置、管理三项读自 `lib/navigation.ts` 的 `account` 分区，皮肤用的是同一份清单。
 * 套餐名每次会话读一次（`planSummaryQueryOptions`），和套餐页共用缓存；读到之前那一行只写「套餐与用量」。
 */
export function SidebarAccount() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const plan = useQuery(planSummaryQueryOptions()).data?.plan?.name;
  const avatarAgentId = useAvatarAgentId();
  const navigation = useNavigationItems();
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  const theme = useOptionalTheme();
  const name = currentUser?.name || currentUser?.email || "";
  const accountLinks = navigation
    .filter(isNavigationLink)
    .filter((item) => item.section === "account");

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              aria-label={`账户：${name}`}
              className="h-[46px] gap-[9px] rounded-[9px] px-[4px] hover:bg-foreground/[0.03]"
            />
          }
        >
          <AccountAvatar label={name} />
          {/* The name and the release the server runs, side by side: 80/20 of the row. */}
          <span className="grid min-w-0 flex-1 grid-cols-[4fr_1fr] items-center gap-2">
            <span className="truncate font-semibold text-[12px]">{name}</span>
            <OpenBotVersion className="text-right text-[10px] text-faint leading-3" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[230px] p-1.5"
          side="top"
          sideOffset={8}
        >
          {avatarAgentId ? (
            <DropdownMenuItem
              className={menuItemClassName}
              render={
                <Link params={{ agentId: avatarAgentId }} to="/bots/$agentId" />
              }
            >
              <AVATAR_MENU_ITEM.icon />
              {AVATAR_MENU_ITEM.label}
            </DropdownMenuItem>
          ) : null}
          {accountLinks.map((item) => (
            <DropdownMenuItem
              className={menuItemClassName}
              key={item.id}
              render={<Link to={item.to} />}
            >
              <item.icon />
              {item.id === "plans" ? (
                <span className="flex min-w-0 flex-col">
                  <span>{item.label}</span>
                  {plan ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {plan}
                    </span>
                  ) : null}
                </span>
              ) : (
                item.label
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={menuItemClassName}>
              <IconBrightness />
              主题
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[160px]">
              <DropdownMenuRadioGroup
                onValueChange={(value) => theme?.setDark(value === "dark")}
                value={theme ? (theme.dark ? "dark" : "light") : undefined}
              >
                <DropdownMenuRadioItem disabled={!theme} value="light">
                  浅色
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem disabled={!theme} value="dark">
                  深色
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {/* The theme preference stores light or dark only; there is no "follow the system" to offer. */}
              <DropdownMenuItem disabled>跟随系统（暂不支持）</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={menuItemClassName}>
              <IconLanguage />
              语言
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[180px]">
              <DropdownMenuRadioGroup value="zh">
                <DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {/* The interface is written in Chinese only; no other language exists to switch to. */}
              <DropdownMenuItem disabled>暂无其他语言</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* Only where there is a sign-in to end: a single-person install has none. */}
          {signOutOffered ? (
            <DropdownMenuItem
              className={menuItemClassName}
              disabled={signOut.pending}
              onClick={signOut.run}
              variant="destructive"
            >
              <IconLogout />
              退出登录
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
