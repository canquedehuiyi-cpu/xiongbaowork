import {
  IconBrightness,
  IconGauge,
  IconLanguage,
  IconLogout,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useOptionalTheme } from "@/components/theme-provider";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { planSummaryQueryOptions } from "@/lib/quota/queries";
import { cn } from "@/lib/utils";

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
      className="flex size-[32px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/15 text-[12px] text-foreground/80"
    >
      {initials}
    </span>
  );
}

/**
 * The foot of the sidebar, as the reference has it: who is signed in and on which plan, a gauge that
 * opens 套餐与用量, and a gear that opens the account menu upward.
 *
 * The plan is read once per session (`planSummaryQueryOptions`) into the cache the plans screen
 * keeps fresh; until that read answers, or if it fails, the second line falls back to the email.
 */
export function SidebarAccount() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const plan = useQuery(planSummaryQueryOptions()).data?.plan?.name;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const theme = useOptionalTheme();
  const name = currentUser?.name || currentUser?.email || "";
  const secondLine =
    plan ?? (currentUser?.name ? currentUser.email : undefined);

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    await navigate({ to: "/sign" });
  };

  return (
    <section
      aria-label="账户"
      className="flex h-[56px] shrink-0 items-center gap-[8px] border-sidebar-border border-t px-[12px]"
    >
      <AccountAvatar label={name} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[13px] leading-[18px]">
          {name}
        </div>
        {secondLine ? (
          <div className="truncate text-[12px] text-muted-foreground leading-[16px]">
            {secondLine}
          </div>
        ) : null}
      </div>
      <Link
        activeProps={{ className: "bg-foreground/5" }}
        aria-label="套餐与用量"
        className={cn(
          buttonVariants({ size: "icon", variant: "ghost" }),
          "size-[28px] shrink-0 text-muted-foreground",
        )}
        title="套餐与用量"
        to="/plans"
      >
        <IconGauge className="size-[16px]" />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="设置"
          className={cn(
            buttonVariants({ size: "icon", variant: "ghost" }),
            "size-[28px] shrink-0 text-muted-foreground",
          )}
          title="设置"
        >
          <IconSettings className="size-[16px]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[220px] p-1.5"
          side="top"
          sideOffset={8}
        >
          <DropdownMenuItem
            className={menuItemClassName}
            render={<Link to="/settings" />}
          >
            <IconSettings />
            设置
          </DropdownMenuItem>
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
          {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
          {currentUser?.role === "admin" ? (
            <DropdownMenuItem
              className={menuItemClassName}
              render={<Link to="/admin" />}
            >
              <IconShieldLock />
              管理
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className={menuItemClassName}
            disabled={signOut.isPending}
            onClick={handleSignOut}
            variant="destructive"
          >
            <IconLogout />
            退出登录
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center gap-2 px-2 py-1.5">
            <AccountAvatar label={name} />
            <div className="min-w-0">
              <div className="truncate font-medium text-[13px]">{name}</div>
              {plan ? (
                <div className="truncate text-[12px] text-muted-foreground">
                  {plan}
                </div>
              ) : null}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  );
}
