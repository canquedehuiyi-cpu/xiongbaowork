import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MineScreen } from "@/components/resources/mine-screen";

/**
 * 能力 › 我的（`/capabilities/mine`，P4）：一个员工被给了什么的单一列表——技能（带移植档位
 * 徽章）、连接器（待绑定的画出来，跳到 `/connections`）、团队（4b 由 `/api/teams` 供给）。
 *
 * 上游没有这个页签；它替代了「能力与资源」页在方案 P4 里定的位置——那个地址（`/resources`）
 * 现在是旧地址重定向（见 archive-resource-pages.test.tsx 锁着的落点表），员工级一览落在这里。
 */
export const Route = createFileRoute("/_authed/_app/capabilities/mine")({
  component: MinePage,
});

function MinePage() {
  return (
    <CapabilitiesShell>
      <MineScreen />
    </CapabilitiesShell>
  );
}
