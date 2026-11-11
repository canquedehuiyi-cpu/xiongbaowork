import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MyDevices } from "@/components/settings/my-devices";

/**
 * 我的设备（M5b：从设置的通用页拆出来，单独一个设置分区）。设备是个人的执行环境：配对一次，之后无人值守地跑，
 * 所以和其他「设好就不用管」的东西放在设置里。
 */
export const Route = createFileRoute("/_authed/settings/devices")({
  component: DevicesSettingsPage,
});

function DevicesSettingsPage() {
  return (
    <PageShell
      description="配对你自己的电脑，让员工在上面替你干活。配对一次之后，它会自己连回来。"
      title="我的设备"
      width="workbench"
    >
      <MyDevices />
    </PageShell>
  );
}
