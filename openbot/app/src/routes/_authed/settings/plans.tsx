import { createFileRoute } from "@tanstack/react-router";
import { PlansPage } from "@/components/quota/plans-page";

/**
 * 套餐与用量（M5b：从 `/plans` 搬进设置；`/plans` 仍重定向到这里，服务端 `upgradeUrl` 的契约不断）。
 * 第 0 步直接挂剪出来的原页面，E 组再按设置页的版式调整。
 */
export const Route = createFileRoute("/_authed/settings/plans")({
  component: PlansPage,
});
