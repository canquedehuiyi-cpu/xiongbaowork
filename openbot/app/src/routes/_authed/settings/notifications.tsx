import { IconChevronRight, IconSend } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { CheckInsSection } from "@/components/settings/check-ins";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { UpdateRoutingSection } from "@/components/settings/update-routing";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

export const Route = createFileRoute("/_authed/settings/notifications")({
  component: NotificationsPage,
});

/**
 * Whether your employees check in for you, and where their updates reach you, for all of them at
 * once (upstream main's three sections). Each employee's own page says how much. The @Waker overview
 * across every chat app and device stays in the main navigation; this page links to it.
 */
function NotificationsPage() {
  return (
    <PageShell
      description="选择你不在时在哪里收到员工的更新，以及员工要不要替你主动巡检。每位员工的更新频率在它自己的页面上设置。"
      title="通知"
    >
      <CheckInsSection />
      <UpdateRoutingSection />
      <NativeDevices />
      <RecentDeliveries />
      <PageSection title="@Waker 触达">
        <PageRows>
          <Item
            render={(props) => <Link {...props} to="/reachability" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconSend />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>触达方式</ItemTitle>
              <ItemDescription>
                员工的更新发到哪些聊天应用和设备，以及每个渠道最近送达了什么。
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
