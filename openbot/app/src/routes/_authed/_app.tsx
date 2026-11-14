import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-sidebar/app-shell";
import { ConversationWorkspace } from "@/components/app-sidebar/conversation-workspace";
import { useActiveSkin } from "@/skins/registry";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const { Frame } = useActiveSkin();

  if (Frame) {
    return (
      <Frame>
        <Outlet />
      </Frame>
    );
  }

  // 「经典」皮肤（原来的外观）：上游的侧栏结构（对话列表、底部主导航、账户菜单），黑白红配色、平铺侧栏。
  // 默认皮肤（聊天工作台）和 OpenDuet / OpenDots / OpenMuse 由皮肤的 Frame 接管（上面）。The desktop update bar
  // (upstream's `UpdateBanner` at this level) is drawn inside AppShell, above its SelfHostBanner, so
  // settings, which share the shell, show it too.
  // 对话页旁边的中间栏（熊宝 v0.2.7，见 conversation-workspace.tsx）；不在对话页时它什么都不画。
  return (
    <AppShell secondary={<ConversationWorkspace />}>
      <Outlet />
    </AppShell>
  );
}
