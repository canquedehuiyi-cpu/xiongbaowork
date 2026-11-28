import {
  createFileRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { PageShell } from "@/components/layout/page-shell";
import {
  TeamComputersSection,
  ThisComputerSections,
} from "@/components/manage/computers-page";
import { MyDevices } from "@/components/settings/my-devices";
import { IdleComputersSection } from "@/components/settings/team/idle-computers-section";
import { NetworkSection } from "@/components/settings/team/network-section";
import {
  type SettingsAudience,
  useSettingsAudience,
} from "@/lib/settings/audience";
import { useAnchorScroll } from "@/lib/settings/use-anchor-scroll";

/**
 * 电脑与设备（spec §5.3.5）：本人配对的设备，个人版这台电脑上的员工浏览器和文件夹，团队版管理员的
 * 团队的电脑、网络和闲置电脑。原来分在「我的设备」、个人版的「电脑」、管理 › 电脑和企业管控四处。
 * 每节自己按受众决定画不画（`SettingsSection`）；我的设备人人都有，排第一。
 */
export const Route = createFileRoute("/_authed/settings/devices")({
  component: DevicesSettingsPage,
});

/**
 * 两个版本各有一节「电脑」：个人版 `#this-computer`、团队版 `#team-computers`。旧地址表（U51、U52）和服务器发来的
 * 地址不知道版本，所以由这一页在读完受众后把另一个版本的锚点换成本版本的那一节（`replace`，不留历史）。
 * 团队成员两节都没有，不换，落在页顶。
 */
const COMPUTER_ANCHOR: Record<SettingsAudience["edition"], string> = {
  personal: "this-computer",
  team: "team-computers",
};

function useEditionComputerAnchor(audience: SettingsAudience): void {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const navigate = useNavigate();
  useEffect(() => {
    if (!audience.ready) return;
    if (audience.edition === "team" && !audience.isAdmin) return;
    const mine = COMPUTER_ANCHOR[audience.edition];
    const other =
      COMPUTER_ANCHOR[audience.edition === "team" ? "personal" : "team"];
    if (hash === other)
      void navigate({ to: "/settings/devices", hash: mine, replace: true });
  }, [audience.ready, audience.edition, audience.isAdmin, hash, navigate]);
}

/** 页面描述：人人有的一句，加上这个人在这页还能管的东西（读完受众之前只有第一句）。 */
function descriptionFor(audience: SettingsAudience): string {
  const own = "配对你自己的电脑，让员工在上面替你干活。";
  if (!audience.ready) return own;
  if (audience.edition === "personal") {
    return `${own}你也可以在这里停止或重置员工的浏览器，并选择员工能读取这台电脑上的哪些文件夹。`;
  }
  if (audience.isAdmin) {
    return `${own}作为管理员，你还可以管理团队的电脑、员工的电脑能连到哪里，以及闲置多久后停掉。`;
  }
  return own;
}

function DevicesSettingsPage() {
  const audience = useSettingsAudience();
  useEditionComputerAnchor(audience);
  useAnchorScroll(audience.ready);
  return (
    <PageShell
      description={descriptionFor(audience)}
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
