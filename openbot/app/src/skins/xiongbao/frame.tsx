import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { UpdateBanner } from "@/components/layout/update-banner";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { type Rail, railForPath } from "@/lib/navigation";
import { ListColumn } from "./list-column";
import { WorkbenchRail } from "./rail";

/**
 * 默认外观的外壳，聊天工作台（设计稿 `docs/specs/assets/2026-11-14-chat-workbench-mock.html`）：
 * 最左 68px 的入口栏，300px 的列表栏，右边是主区。主区照常画路由页面（`children`），更新横幅和自托管
 * 横幅在它顶上，和原来的外壳一样。
 *
 * 亮哪个入口跟着地址走（`railForPath`），刷新、直达链接都落到对的入口。点一下入口栏，列表栏先切过去，
 * 主区不动，像微信那样；地址一变，入口又回到地址所属的那个。「我」例外：它直接落到「我」页面（`/me`）。
 *
 * 颜色只从 `--wb-*` 令牌取（`skin.css`），暗色跟着 `<html class="dark">`。
 */
export function WorkbenchFrame({ children }: { children: ReactNode }) {
  // 整个应用一条推送连接，开在名册保持最新的地方，和原来的侧栏一样。
  useChannelEvents();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<{ rail: Rail; at: string } | null>(null);
  const rail =
    chosen && chosen.at === pathname ? chosen.rail : railForPath(pathname);

  return (
    <div
      className="grid h-svh grid-cols-[68px_300px_minmax(0,1fr)] overflow-hidden bg-(--wb-frame) text-foreground"
      data-workbench-frame
    >
      <WorkbenchRail
        onSelect={(next) => {
          setChosen({ rail: next, at: pathname });
          // 已经在 /me 时地址不变，靠上面这一行把列表栏切回「我」。
          if (next === "me") void navigate({ to: "/me" });
        }}
        rail={rail}
      />
      <aside
        aria-label="列表栏"
        className="flex min-h-0 min-w-0 flex-col border-(--wb-line) border-r bg-(--wb-list) text-(--wb-fg)"
        data-workbench-list={rail}
      >
        <ListColumn rail={rail} />
      </aside>
      <main
        className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--wb-main)"
        data-workbench-main
      >
        {/* Only inside the desktop app: the banner asks it, and draws nothing in a browser. */}
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </main>
    </div>
  );
}
