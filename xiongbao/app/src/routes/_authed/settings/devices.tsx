import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import {
  TeamComputersSection,
  ThisComputerSections,
} from "@/components/manage/computers-page";
import { MyDevices } from "@/components/settings/my-devices";
import { IdleComputersSection } from "@/components/settings/team/idle-computers-section";
import { NetworkSection } from "@/components/settings/team/network-section";
import { useSettingsAudience } from "@/lib/settings/audience";
import { useAnchorScroll } from "@/lib/settings/use-anchor-scroll";

/**
 * 电脑与设备（spec §5.3.5）：本人配对的设备，个人版这台电脑上的员工浏览器和文件夹，团队版管理员的
 * 团队的电脑、网络和闲置电脑。原来分在「我的设备」、个人版的「电脑」、管理 › 电脑和企业管控四处。
 * 每节自己按受众决定画不画（`SettingsSection`）；我的设备人人都有，排第一。
 */
export const Route = createFileRoute("/_authed/settings/devices")({
  component: DevicesSettingsPage,
});

function DevicesSettingsPage() {
  const audience = useSettingsAudience();
  useAnchorScroll(audience.ready);
  return (
    <PageShell
      description="配对你自己的电脑，让员工在上面替你干活。配对一次之后，它会自己连回来。"
      title="电脑与设备"
      width="workbench"
    >
      <MyDevices />
      <ThisComputerSections />
      <TeamComputersSection />
      <NetworkSection />
      <IdleComputersSection />
    </PageShell>
  );
}
