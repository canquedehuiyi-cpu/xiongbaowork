import { createFileRoute } from "@tanstack/react-router";
import { MePage } from "@/skins/xiongbao/me-page";

/**
 * 「我」（聊天工作台目标 5）：个人卡和取代原账户菜单的菜单。默认皮肤里入口栏的「我」落到这里；别的皮肤
 * （包括「经典」）里它照样画在原来的外壳里。
 */
export const Route = createFileRoute("/_authed/_app/me")({
  component: MePage,
});
