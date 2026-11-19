import { createFileRoute } from "@tanstack/react-router";
import { WorkbenchHome } from "@/skins/xiongbao/workbench-home";

/**
 * 工作台首页（聊天工作台目标 4）：问候、今日数据、今日动态、应用格子，管理员多一块「管理」。默认皮肤里
 * 入口栏的「工作台」落到这里；别的皮肤（包括「经典」）里它照样画在原来的外壳里。
 */
export const Route = createFileRoute("/_authed/_app/workbench")({
  component: () => <WorkbenchHome />,
});
