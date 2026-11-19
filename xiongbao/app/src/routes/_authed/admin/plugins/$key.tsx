import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/components/manage/plugin-page";

/**
 * One connector under Admin（M5b 起与上游一致，是薄壳）。The page itself is `PluginPage`, shared with
 * the personal edition's app page; 熊宝独有的员工组批量授予、放置式凭据（credentialLabel/Hint）、替换令牌、
 * 换实例地址和按目录键打开都并进了那里。
 */
export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
});

function RouteComponent() {
  const { key } = Route.useParams();
  return <PluginPage pluginKey={key} />;
}
