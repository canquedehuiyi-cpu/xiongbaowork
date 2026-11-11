import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MyDevices } from "@/components/settings/my-devices";

/**
 * 我的设备（M5b：从设置的通用页拆出来，单独一个设置分区）。第 0 步先挂现有的 `MyDevices`；从通用页摘掉它、
 * 加进设置侧栏是 E 组的事。
 */
export const Route = createFileRoute("/_authed/settings/devices")({
  component: DevicesSettingsPage,
});

function DevicesSettingsPage() {
  return (
    <PageShell title="我的设备">
      <MyDevices />
    </PageShell>
  );
}
