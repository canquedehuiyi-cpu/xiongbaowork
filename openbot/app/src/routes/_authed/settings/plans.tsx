import { createFileRoute } from "@tanstack/react-router";
import { PlansPage } from "@/components/quota/plans-page";

/**
 * 套餐与用量（M5b：从 `/plans` 搬进设置；`/plans` 仍重定向到这里，服务端 `upgradeUrl` 的契约不断）。
 * 账户菜单的「套餐与用量」和侧栏用量面板都链到这里。
 */
export const Route = createFileRoute("/_authed/settings/plans")({
  component: PlansPage,
});
