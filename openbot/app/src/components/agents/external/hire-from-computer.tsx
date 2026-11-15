import {
  IconCloud,
  IconDeviceLaptop,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconTerminal2,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  type AcpHarness,
  type AgentTag,
  agentTags,
  DISCOVERED_HARNESSES,
  type DiscoveredAgent,
  type DiscoveredHarness,
  deviceStanding,
  discoveryQueryOptions,
  HARNESS_LABEL,
} from "@/lib/agents/external";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import {
  devicesQueryOptions,
  type RegisteredDevice,
} from "@/lib/devices/queries";
import { cn } from "@/lib/utils";

/**
 * 「招一位新同事」的「从我的电脑招」页签（外部员工 Task 10，设计稿第 1 屏）。
 *
 * 选一台本人配对的电脑（只有 `pairedByUserId` 是自己的那几台能招），在线时当场问它装了哪些智能体：装好的
 * 每家一张卡（已安装 / 已登录 / 模型待确认 / 登录状态未知），点「招进来」去招聘设置；没装的列出名字和
 * 「怎么安装」；另有「其他支持开放协议的智能体 · 手动添加」（启动命令在桌面端登记，这里只选登记过的）。
 * 电脑离线、还没认主人、是别人配对的，都只写明白为什么，不给招聘按钮。
 */

/** 每家一句话说它是什么、用谁的订阅（设计稿的卡片文字）。 */
const ABOUT: Record<DiscoveredHarness, { kind: string; plan: string }> = {
  codex: {
    kind: "命令行编程智能体",
    plan: "用你自己的 ChatGPT 订阅干活",
  },
  "claude-code": {
    kind: "命令行编程智能体",
    plan: "用你自己的 Claude 订阅干活",
  },
  hermes: {
    kind: "通用智能体，会自己长技能",
    plan: "用它自己配置的模型干活",
  },
};

/** 没装时去哪里看安装说明：各家自己的文档。 */
export const INSTALL_URL: Record<DiscoveredHarness, string> = {
  codex: "https://github.com/openai/codex",
  "claude-code": "https://docs.claude.com/en/docs/claude-code/setup",
  hermes: "https://github.com/NousResearch/hermes-agent",
};

/** 卡片上的标识：各家自己发布的标识（`shared/marks`），没有的不画字母代替。 */
const MARK_ID: Record<DiscoveredHarness, string | null> = {
  codex: "openai",
  "claude-code": "claude",
  hermes: null,
};

/** 装了但还接不上时，卡片上说怎么办。 */
const NOT_READY: Record<DiscoveredHarness, string> = {
  codex: "先在这台电脑上装好 Node.js，再点「重新查找」。",
  "claude-code": "先在这台电脑上装好 Node.js，再点「重新查找」。",
  hermes: "这个版本的 Hermes 还不支持开放协议，升级后点「重新查找」。",
};

export function harnessAbout(harness: DiscoveredHarness) {
  return ABOUT[harness];
}

/** 卡片和招聘设置页头部的标识格子。 */
export function HarnessTile({
  harness,
  name,
  size = "md",
}: {
  harness: AcpHarness;
  name: string;
  size?: "md" | "lg";
}) {
  const mark = harness === "custom" ? null : MARK_ID[harness];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-[12px] border border-border",
        size === "lg" ? "size-[52px] rounded-[14px]" : "size-[44px]",
        mark ? "bg-white" : "bg-muted text-muted-foreground",
      )}
      data-slot="hire-tile"
    >
      {mark ? (
        <HarnessMark className="size-6 dark:p-0" id={mark} name={name} />
      ) : (
        <IconTerminal2 className="size-[22px]" stroke={1.8} />
      )}
    </span>
  );
}

function Tag({ tag }: { tag: AgentTag }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-[3px] text-[12px]",
        tag.tone === "good"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
      data-slot="hire-tag"
      data-tone={tag.tone}
    >
      {tag.label}
    </span>
  );
}

/** 一句状态，画在页签下面的大块里（离线、没认主人、没有电脑……）。 */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground leading-relaxed"
      data-slot="hire-notice"
    >
      {children}
    </div>
  );
}

function AgentCard({
  agent,
  onHire,
}: {
  agent: DiscoveredAgent;
  onHire: () => void;
}) {
  const label = HARNESS_LABEL[agent.harness];
  const about = ABOUT[agent.harness];
  return (
    <article
      aria-label={label}
      className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-[18px]"
      data-slot="hire-card"
    >
      <div className="flex items-center gap-3">
        <HarnessTile harness={agent.harness} name={label} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-semibold text-[16px]">{label}</h3>
          <span className="text-[12px] text-muted-foreground">
            {about.kind}
            {agent.version ? ` · ${agent.version}` : ""}
          </span>
        </div>
      </div>
      <ul
        aria-label="状态"
        className="m-0 flex list-none flex-wrap gap-1.5 p-0"
      >
        {agentTags(agent).map((tag) => (
          <li key={tag.label}>
            <Tag tag={tag} />
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-muted-foreground leading-relaxed">
        {about.plan}，{shortName()}不另收模型费。
      </p>
      {agent.acpReady ? null : (
        <p
          className="m-0 text-[12px] text-amber-700 leading-relaxed dark:text-amber-300"
          data-slot="hire-warning"
        >
          {NOT_READY[agent.harness]}
        </p>
      )}
      <Button
        aria-label={`把 ${label} 招进来`}
        className="mt-auto h-10 w-full font-semibold"
        data-hire-primary=""
        disabled={!agent.acpReady}
        onClick={onHire}
      >
        招进来
      </Button>
    </article>
  );
}

/** 默认选哪台：指定的那台；否则本人配对、在线的第一台；再否则本人配对的第一台；再否则第一台。 */
function pickDevice(
  devices: readonly RegisteredDevice[],
  wanted: string | undefined,
  me: string | undefined,
): RegisteredDevice | undefined {
  const mine = devices.filter(
    (device) => deviceStanding(device, me) === "mine",
  );
  return (
    devices.find((device) => device.deviceId === wanted) ??
    mine.find((device) => device.online) ??
    mine[0] ??
    devices[0]
  );
}

export function HireFromComputer({
  deviceId,
  onDeviceChange,
  onHire,
}: {
  deviceId?: string;
  /** 「换一台电脑」：换成哪台（`deviceId`）。 */
  onDeviceChange?: (deviceId: string) => void;
  /** 点「招进来」或「手动添加」：去这台电脑上这一家的招聘设置。 */
  onHire: (deviceId: string, harness: AcpHarness) => void;
}) {
  const devices = useQuery(devicesQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data?.id;

  if (devices.isError && !devices.data)
    return (
      <QueryError
        error={devices.error}
        label="读不到你的电脑"
        onRetry={() => void devices.refetch()}
        retrying={devices.isFetching}
      />
    );
  if (!devices.data)
    return (
      <p className="text-[13px] text-muted-foreground" role="status">
        正在读你的电脑…
      </p>
    );

  const device = pickDevice(devices.data, deviceId, me);
  if (!device)
    return (
      <Notice>
        <p className="m-0 font-semibold text-foreground">还没有配对的电脑</p>
        <p className="m-0">
          在你的电脑上装好{shortName()}桌面端并配对，就能把它上面的
          Codex、Claude Code、Hermes 招进来当员工。
        </p>
        <Link
          className="w-fit text-primary underline underline-offset-4"
          data-slot="hire-link"
          to="/settings/devices"
        >
          去配对一台电脑
        </Link>
      </Notice>
    );

  return (
    <div className="flex flex-col gap-[22px]" data-slot="hire-from-computer">
      <DeviceBar
        device={device}
        devices={devices.data}
        me={me}
        onDeviceChange={onDeviceChange}
      />
      <DeviceAgents
        device={device}
        me={me}
        onHire={onHire}
        onlyDevice={devices.data.length === 1}
      />
    </div>
  );
}

function DeviceBar({
  device,
  devices,
  me,
  onDeviceChange,
}: {
  device: RegisteredDevice;
  devices: readonly RegisteredDevice[];
  me: string | undefined;
  onDeviceChange?: (deviceId: string) => void;
}) {
  const standing = deviceStanding(device, me);
  const discovery = useQuery({
    ...discoveryQueryOptions(device.deviceId),
    enabled: standing === "mine" && device.online,
  });
  const online = device.online && discovery.data?.online !== false;
  // 只数现在就能招的：装了但还接不上的不算。
  const found = discovery.data?.online
    ? discovery.data.agents.filter((agent) => agent.installed && agent.acpReady)
        .length
    : undefined;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
      data-slot="hire-device"
    >
      <IconDeviceLaptop
        aria-hidden="true"
        className="size-5 text-muted-foreground"
        stroke={1.8}
      />
      <span className="font-semibold">{device.name}</span>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-[13px]",
          online
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-muted-foreground",
        )}
        data-online={online ? "" : undefined}
        data-slot="hire-presence"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full",
            online ? "bg-emerald-500" : "bg-muted-foreground/60",
          )}
        />
        {online ? "在线" : "电脑离线"}
      </span>
      {found !== undefined && standing === "mine" ? (
        <span className="text-[13px] text-muted-foreground">
          {found > 0
            ? `在这台电脑上找到 ${found} 个能招的智能体`
            : "这台电脑上还没找到能招的智能体"}
        </span>
      ) : null}
      <span className="grow" />
      {standing === "mine" && online ? (
        <Button
          disabled={discovery.isFetching}
          onClick={() => void discovery.refetch()}
          size="sm"
          variant="ghost"
        >
          <IconRefresh aria-hidden="true" />
          {discovery.isFetching ? "正在查找…" : "重新查找"}
        </Button>
      ) : null}
      {devices.length > 1 ? (
        <label className="inline-flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">换一台电脑</span>
          <select
            className="h-8 rounded-[9px] border border-border bg-muted px-2 text-foreground"
            data-slot="hire-select"
            onChange={(event) => onDeviceChange?.(event.target.value)}
            value={device.deviceId}
          >
            {devices.map((option) => (
              <option key={option.deviceId} value={option.deviceId}>
                {option.name}
                {option.online ? "" : "（离线）"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/** 唯一的一台电脑招不了时，给一条去配对别的电脑的路。 */
function PairLink() {
  return (
    <Link
      className="w-fit text-primary underline underline-offset-4"
      data-slot="hire-link"
      to="/settings/devices"
    >
      去配对一台电脑
    </Link>
  );
}

function DeviceAgents({
  device,
  me,
  onHire,
  onlyDevice,
}: {
  device: RegisteredDevice;
  me: string | undefined;
  onHire: (deviceId: string, harness: AcpHarness) => void;
  /** 只有这一台电脑：它招不了时没有「换一台电脑」，就给去配对的链接。 */
  onlyDevice: boolean;
}) {
  const standing = deviceStanding(device, me);
  const discovery = useQuery({
    ...discoveryQueryOptions(device.deviceId),
    enabled: standing === "mine" && device.online,
  });

  if (standing === "unclaimed")
    return (
      <Notice>
        <p className="m-0">
          这台电脑还没认主人，在桌面端重新登录一次即可认领，之后就能在上面招外部员工。
        </p>
        {onlyDevice ? <PairLink /> : null}
      </Notice>
    );
  if (standing === "others")
    return (
      <Notice>
        <p className="m-0">
          这台电脑是别人配对的。只能在你自己配对的电脑上招外部员工。
        </p>
        {onlyDevice ? <PairLink /> : null}
      </Notice>
    );
  if (!device.online || discovery.data?.online === false)
    return (
      <Notice>
        <p className="m-0 font-semibold text-foreground">电脑离线</p>
        <p className="m-0">
          打开这台电脑、让{shortName()}
          桌面端连上后，这里会列出它上面能招的智能体。
        </p>
        {onlyDevice ? <PairLink /> : null}
      </Notice>
    );
  if (discovery.isError && !discovery.data)
    return (
      <QueryError
        error={discovery.error}
        label="读不到这台电脑上的智能体"
        onRetry={() => void discovery.refetch()}
        retrying={discovery.isFetching}
      />
    );
  if (!discovery.data)
    return (
      <p className="text-[13px] text-muted-foreground" role="status">
        正在这台电脑上找智能体…
      </p>
    );

  const byHarness = new Map(
    discovery.data.agents.map((agent) => [agent.harness, agent]),
  );
  const installed = DISCOVERED_HARNESSES.flatMap((harness) => {
    const agent = byHarness.get(harness);
    return agent?.installed ? [agent] : [];
  });
  const missing = DISCOVERED_HARNESSES.filter(
    (harness) => !byHarness.get(harness)?.installed,
  );

  return (
    <>
      {installed.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {installed.map((agent) => (
            <AgentCard
              agent={agent}
              key={agent.harness}
              onHire={() => onHire(device.deviceId, agent.harness)}
            />
          ))}
        </div>
      ) : null}
      <section aria-label="还没装的" className="flex flex-col gap-2.5">
        <h3 className="m-0 font-normal text-[13px] text-muted-foreground">
          {missing.length > 0
            ? "这台电脑上还没装，装好后点「重新查找」就会出现在上面"
            : "别的智能体"}
        </h3>
        <div className="flex flex-wrap gap-2.5">
          {missing.map((harness) => (
            <a
              className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-2 text-[13px] text-muted-foreground hover:text-foreground"
              data-slot="hire-chip"
              href={INSTALL_URL[harness]}
              key={harness}
              rel="noreferrer"
              target="_blank"
            >
              {HARNESS_LABEL[harness]} · 怎么安装
              <IconExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ))}
          <button
            className="inline-flex items-center gap-2 rounded-full border border-border border-dashed px-3.5 py-2 text-[13px] text-muted-foreground hover:text-foreground"
            data-slot="hire-chip"
            onClick={() => onHire(device.deviceId, "custom")}
            type="button"
          >
            <IconPlus aria-hidden="true" className="size-3.5" />
            其他支持开放协议的智能体 · 手动添加
          </button>
        </div>
      </section>
    </>
  );
}

/** 「云端（下一步）」页签：这一步只说明，不能招（规格第 5 节）。 */
export function HireFromCloud() {
  return (
    <Notice>
      <p className="m-0 flex items-center gap-2 font-semibold text-foreground">
        <IconCloud aria-hidden="true" className="size-5" stroke={1.8} />
        云端（下一步）
      </p>
      <p className="m-0">
        下一步，同一批外部员工也能在云端干活：你的电脑关机时，活可以转到云端继续。
      </p>
      <p className="m-0">
        现在请先在「从我的电脑招」里，把电脑上的智能体招进来。
      </p>
    </Notice>
  );
}
