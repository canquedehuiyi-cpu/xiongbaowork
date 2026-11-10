import { IconChevronRight, IconSend } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { CheckInsSection } from "@/components/settings/check-ins";
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
 * Whether your employees check in for you, for all of them at once; each employee's own page says
 * how often. Where their updates reach you (chat apps, devices, what was delivered lately) is this
 * fork's reachability page, which upstream's Notifications page split into three sections.
 */
function NotificationsPage() {
  return (
    <PageShell
      description="决定员工要不要替你主动巡检，以及你不在时更新送到哪里。每位员工的巡检频率在它自己的页面上设置。"
      title="通知"
    >
      <CheckInsSection />
      <PageSection title="送到哪里">
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
                员工的更新发到哪些聊天应用和设备，以及最近送达了什么。
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
