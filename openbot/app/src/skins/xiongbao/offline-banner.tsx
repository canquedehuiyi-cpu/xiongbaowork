import type { Presence } from "@/lib/agents/presence";
import type { AgentProfile } from "@/lib/agents/queries";
import type { RegisteredDevice } from "@/lib/devices/queries";

/** 一台离线的电脑，和在它上面、此刻离线的外部员工。 */
export type OfflineComputer = {
  deviceId: string;
  device?: RegisteredDevice;
  employees: { agent: AgentProfile; queued: number }[];
};

/**
 * 此刻离线的外部员工按电脑归拢：只看读到「离线」的那几位（读不到的、在线的都不算），一台电脑一条。没有就是
 * 空的，消息列表顶上就没有提示条。
 */
export function offlineComputers(
  agents: readonly AgentProfile[],
  presence: ReadonlyMap<string, Presence>,
  devices: ReadonlyMap<string, RegisteredDevice>,
): OfflineComputer[] {
  const byDevice = new Map<string, OfflineComputer>();
  for (const agent of agents) {
    const external = agent.external;
    const now = presence.get(agent.id);
    if (!external || now?.status !== "offline") continue;
    const entry = byDevice.get(external.deviceId) ?? {
      deviceId: external.deviceId,
      device: devices.get(external.deviceId),
      employees: [],
    };
    entry.employees.push({ agent, queued: Math.max(0, now.queued ?? 0) });
    byDevice.set(external.deviceId, entry);
  }
  return [...byDevice.values()];
}

/**
 * 消息列表顶上的离线提示条（外部员工 Task 11，设计稿第 6 屏）：哪台电脑离线了、谁有几件活在排队、电脑开机后
 * 自动继续，你现在派的活也会排进去；最后一行说明下一步云端上线后能做什么。只在有外部员工离线时出现，一台
 * 电脑一条。颜色都是工作台的 `--wb-*` 令牌：这个列表只画在默认皮肤里。
 */
export function OfflineBanner({ computer }: { computer: OfflineComputer }) {
  const names = computer.employees.map(({ agent }) => agent.name).join("、");
  // 谁排着几件，按人说：「代码熊有 2 件」「代码熊有 2 件、双子有 1 件」。
  const waiting = computer.employees
    .filter((employee) => employee.queued > 0)
    .map(({ agent, queued }) => `${agent.name}有 ${queued} 件`)
    .join("、");
  const first = computer.employees[0];
  // 电脑名读不到时（电脑列表没读出来），说是谁所在的电脑。
  const where =
    computer.device?.name ?? (first ? `${first.agent.name}所在的电脑` : "电脑");
  return (
    <section
      aria-label="电脑离线"
      className="mx-4 mb-2.5 flex flex-col gap-1.5 rounded-(--wb-radius) border border-(--wb-line2) bg-(--wb-card) px-3.5 py-3 text-(--wb-fg)"
      data-offline-banner={computer.deviceId}
    >
      <p className="m-0 flex min-w-0 items-center gap-2 text-[13.5px]">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-(--wb-paused)"
        />
        <b className="min-w-0 truncate font-semibold">{where} 已离线</b>
      </p>
      <p className="m-0 text-(--wb-fg2) text-[12.5px] leading-relaxed">
        {waiting
          ? `${waiting}活在排队，电脑开机后自动继续。你现在派的活也会排进去。`
          : `派给${names}的活会排队，电脑开机后自动继续。`}
      </p>
      <p className="m-0 text-(--wb-muted) text-[12px] leading-relaxed">
        下一步上线云端后，可以设成「电脑关机时转到云端继续」。
      </p>
    </section>
  );
}
