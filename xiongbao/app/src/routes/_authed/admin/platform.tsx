import { createFileRoute } from "@tanstack/react-router";
import { PlatformPage } from "@/components/platform/platform-page";

/**
 * 平台管理（M5b：从 `/platform` 搬进管理；`/platform` 仍重定向到这里）。服务端只认 `role === "admin"`，
 * 管理侧栏的「平台」分组链到这里。
 */
export const Route = createFileRoute("/_authed/admin/platform")({
  component: PlatformPage,
});
