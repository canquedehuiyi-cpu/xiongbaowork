import { createFileRoute } from "@tanstack/react-router";
import { BriefingPage } from "@/skins/xiongbao/briefing-page";

/**
 * 清点（交付闭环 Task 10，设计稿 4）：开工 / 收工清点的全文，手机推送「清点」点开落到这里，看板清点条的
 * 「逐件看」也到这里。默认皮肤里在工作台的手机布局里画；别的皮肤里照样画在原来的外壳里。
 */
export const Route = createFileRoute("/_authed/_app/briefing")({
  component: () => <BriefingPage />,
});
