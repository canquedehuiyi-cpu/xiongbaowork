import { createFileRoute } from "@tanstack/react-router";
import { ContactsPage } from "@/skins/xiongbao/contacts";

/**
 * 通讯录 › 组织架构（聊天工作台目标 3）：本人的员工按部门分组，点开是员工名片。默认皮肤里入口栏的「通讯录」
 * 落到这里；别的皮肤（包括「经典」）里它照样画在原来的外壳里。
 */
export const Route = createFileRoute("/_authed/_app/contacts")({
  component: ContactsPage,
});
