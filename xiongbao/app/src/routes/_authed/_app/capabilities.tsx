import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * 能力：插件、技能、知识库、WakerFlow、公开项目、模型库、组件、记忆与信息源、角色模板，每个页签一个子路由
 * （`capabilities.<tab>.tsx`），`/capabilities` 本身打开插件页签。每个页签自己画 `CapabilitiesShell`，
 * 标题为什么不在这里画，见那里的说明。
 */
export const Route = createFileRoute("/_authed/_app/capabilities")({
  component: Outlet,
});
