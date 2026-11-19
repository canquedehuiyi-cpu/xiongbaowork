import { IconCloud, IconDeviceLaptop } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { HarnessTile } from "@/components/agents/external/hire-from-computer";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ACP_RULE_DEFAULTS,
  type DiscoveredHarness,
  deviceStanding,
  discoveryQueryOptions,
  HARNESS_LABEL,
  hiredRun,
  hireExternalMutationOptions,
  LOCAL_ONLY_NOTE,
} from "@/lib/agents/external";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import {
  devicesQueryOptions,
  type RegisteredDevice,
} from "@/lib/devices/queries";
import { cn } from "@/lib/utils";

/**
 * 「固定员工」（8.3）：Claude Code 和 Codex 两张现成的卡，一键启用，不用选电脑、不用填 key，模型走
 * 模型代理、用这位员工绑定的模型。
 *
 * - Claude Code 默认跑在自己的云电脑里，不需要配对电脑；启用后在员工设置里可以切到本机。
 * - Codex 只能在你自己的电脑上跑，要先配对一台在线的电脑；这里不给云电脑的选项，并写明原因。
 *
 * 启用走现有的招聘接口（`POST /api/agents/external`），员工记录由服务器创建：Claude Code 是 `runtime: "cloud"`，
 * Codex 是 `runtime: "device"`。已经有这一家的外部员工就不再启用第二个，卡片上给它的入口。
 */
const FIXED: readonly DiscoveredHarness[] = ["claude-code", "codex"];

const ABOUT: Record<"claude-code" | "codex", string> = {
  "claude-code":
    "命令行编程智能体，默认在你自己的云电脑里干活，关掉网页照样跑，不用配对电脑。",
  codex: "命令行编程智能体，只在你自己的电脑上干活，改你本机的代码。",
};

export function FixedEmployees({
  onOpen,
}: {
  /** 启用成功，去这位员工的页面。 */
  onOpen: (agentId: string) => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const rows = Array.isArray(agents.data) ? agents.data : [];
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      data-slot="fixed-employees"
    >
      {FIXED.map((harness) => {
        const existing = rows.find(
          (agent) => hiredRun(agent)?.harness === harness,
        );
        return harness === "claude-code" ? (
          <ClaudeCodeCard existing={existing} key={harness} onOpen={onOpen} />
        ) : (
          <CodexCard existing={existing} key={harness} onOpen={onOpen} />
        );
      })}
    </div>
  );
}

function Card({
  harness,
  children,
}: {
  harness: "claude-code" | "codex";
  children: ReactNode;
}) {
  const label = HARNESS_LABEL[harness];
  return (
    <article
      aria-label={label}
      className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-[18px]"
      data-slot="fixed-card"
      data-harness={harness}
    >
      <div className="flex items-center gap-3">
        <HarnessTile harness={harness} name={label} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-semibold text-[16px]">{label}</h3>
          <span className="text-[12px] text-muted-foreground">固定员工</span>
        </div>
      </div>
      <p className="m-0 text-[13px] text-muted-foreground leading-relaxed">
        {ABOUT[harness]}
      </p>
      {children}
    </article>
  );
}

function Where({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p
      className="m-0 flex items-center gap-2 text-[13px]"
      data-slot="fixed-runtime"
    >
      <span aria-hidden="true" className="text-muted-foreground">
        {icon}
      </span>
      {children}
    </p>
  );
}

function Notice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warn";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "m-0 text-[12px] leading-relaxed",
        tone === "warn"
          ? "text-amber-700 dark:text-amber-300"
          : "text-muted-foreground",
      )}
      data-slot="fixed-notice"
    >
      {children}
    </p>
  );
}

/** 已经启用：写明在哪里跑，给打开和设置两个入口。 */
function Enabled({ agent }: { agent: AgentProfile }) {
  return (
    <div className="mt-auto flex flex-col gap-2">
      <span
        className="w-fit rounded-full bg-emerald-500/15 px-2 py-[3px] text-[12px] text-emerald-700 dark:text-emerald-300"
        data-slot="fixed-enabled"
      >
        已启用 · {agent.name}
      </span>
      <div className="flex gap-2">
        <Link
          className={cn(buttonVariants(), "h-10 flex-1 font-semibold")}
          params={{ agentId: agent.id }}
          to="/bots/$agentId"
        >
          打开
        </Link>
        <Link
          className={cn(buttonVariants({ variant: "outline" }), "h-10")}
          params={{ agentId: agent.id }}
          to="/bots/$agentId/setup"
        >
          设置
        </Link>
      </div>
    </div>
  );
}

function ClaudeCodeCard({
  existing,
  onOpen,
}: {
  existing: AgentProfile | undefined;
  onOpen: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const hire = useMutation(hireExternalMutationOptions(queryClient));
  const where =
    hiredRun(existing)?.runtime === "cloud" ? "云电脑" : "你自己的电脑";
  return (
    <Card harness="claude-code">
      <Where icon={existing ? <IconDeviceLaptop /> : <IconCloud />}>
        运行位置：{existing ? where : "云电脑"}
      </Where>
      <Notice>
        不用填 key，模型走{shortName()}
        的模型代理。想改在本机跑：启用后在员工设置里把「运行位置」切到「本机」。
      </Notice>
      {existing ? (
        <Enabled agent={existing} />
      ) : (
        <>
          {hire.error ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {hire.error.message}
            </p>
          ) : null}
          <Button
            aria-label="启用 Claude Code"
            className="mt-auto h-10 w-full font-semibold"
            disabled={hire.isPending}
            onClick={() =>
              hire.mutate(
                {
                  runtime: "cloud",
                  harness: "claude-code",
                  name: HARNESS_LABEL["claude-code"],
                  rules: ACP_RULE_DEFAULTS,
                },
                { onSuccess: (agent) => onOpen(agent.id) },
              )
            }
          >
            {hire.isPending ? "正在启用…" : "启用"}
          </Button>
        </>
      )}
    </Card>
  );
}

/** 这台电脑上能不能启用 Codex：不能就是一句原因，能就是 null。 */
function whyNot(
  device: RegisteredDevice | undefined,
  folder: string | undefined,
  discovery: ReturnType<typeof useDiscovery>,
): string | null {
  if (!device) return null;
  if (!device.online)
    return `电脑离线：打开这台电脑、让${shortName()}桌面端连上后再启用。`;
  if (!folder)
    return "这台电脑还没有共享文件夹。请先在桌面端添加一个，再回来启用。";
  const found = discovery.data;
  if (found && !found.online)
    return `电脑离线：打开这台电脑、让${shortName()}桌面端连上后再启用。`;
  const codex = found?.agents.find((agent) => agent.harness === "codex");
  if (found && !codex?.installed)
    return "这台电脑上还没装 Codex，装好后再启用。";
  if (found && codex && !codex.acpReady)
    return "这台电脑上的 Codex 还接不上，先在这台电脑上装好 Node.js。";
  return null;
}

function useDiscovery(device: RegisteredDevice | undefined) {
  return useQuery({
    ...discoveryQueryOptions(device?.deviceId ?? ""),
    enabled: Boolean(device?.online),
  });
}

function CodexCard({
  existing,
  onOpen,
}: {
  existing: AgentProfile | undefined;
  onOpen: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const hire = useMutation(hireExternalMutationOptions(queryClient));
  const devices = useQuery(devicesQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data?.id;
  const [wantedDevice, setWantedDevice] = useState<string>();
  const [wantedFolder, setWantedFolder] = useState<string>();

  const own = (Array.isArray(devices.data) ? devices.data : []).filter(
    (device) => deviceStanding(device, me) === "mine",
  );
  const device =
    own.find((row) => row.deviceId === wantedDevice) ??
    own.find((row) => row.online) ??
    own[0];
  const roots = device?.roots ?? [];
  const folder =
    roots.find((root) => root.ref === wantedFolder) ?? roots[0] ?? undefined;
  const discovery = useDiscovery(device);
  const blocked = whyNot(device, folder?.ref, discovery);

  return (
    <Card harness="codex">
      <Where icon={<IconDeviceLaptop />}>运行位置：你自己的电脑</Where>
      {/* 界面上没有云电脑可选：写明为什么，和服务器拒绝时说的是同一句。 */}
      <Notice tone="warn">{LOCAL_ONLY_NOTE}</Notice>
      {existing ? (
        <Enabled agent={existing} />
      ) : devices.isPending ? (
        <Notice>正在读你的电脑…</Notice>
      ) : !device ? (
        <>
          <Notice>
            还没有配对的电脑。先在你的电脑上装好{shortName()}
            桌面端并配对，再来启用。
          </Notice>
          <Link
            className="w-fit text-[13px] text-primary underline underline-offset-4"
            data-slot="hire-link"
            to="/settings/devices"
          >
            去配对一台电脑
          </Link>
          <Button
            aria-label="启用 Codex"
            className="mt-auto h-10 w-full font-semibold"
            disabled
          >
            启用
          </Button>
        </>
      ) : (
        <>
          <div
            className="flex flex-col gap-2 text-[13px]"
            data-slot="fixed-target"
          >
            {own.length > 1 ? (
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">电脑</span>
                <select
                  className="h-8 min-w-0 flex-1 rounded-[9px] border border-border bg-muted px-2 text-foreground"
                  onChange={(event) => {
                    setWantedDevice(event.target.value);
                    setWantedFolder(undefined);
                  }}
                  value={device.deviceId}
                >
                  {own.map((row) => (
                    <option key={row.deviceId} value={row.deviceId}>
                      {row.name}
                      {row.online ? "" : "（离线）"}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span>
                <span className="text-muted-foreground">电脑　</span>
                {device.name}
                {device.online ? "" : "（离线）"}
              </span>
            )}
            {roots.length > 1 ? (
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">文件夹</span>
                <select
                  className="h-8 min-w-0 flex-1 rounded-[9px] border border-border bg-muted px-2 text-foreground"
                  onChange={(event) => setWantedFolder(event.target.value)}
                  value={folder?.ref}
                >
                  {roots.map((root) => (
                    <option key={root.ref} value={root.ref}>
                      {root.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : folder ? (
              <span>
                <span className="text-muted-foreground">文件夹</span>
                {folder.name}
              </span>
            ) : null}
          </div>
          {blocked ? <Notice>{blocked}</Notice> : null}
          {hire.error ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {hire.error.message}
            </p>
          ) : null}
          <Button
            aria-label="启用 Codex"
            className="mt-auto h-10 w-full font-semibold"
            disabled={Boolean(blocked) || !folder || hire.isPending}
            onClick={() => {
              if (!folder) return;
              hire.mutate(
                {
                  runtime: "device",
                  harness: "codex",
                  deviceId: device.deviceId,
                  workdirRef: folder.ref,
                  name: HARNESS_LABEL.codex,
                  rules: ACP_RULE_DEFAULTS,
                },
                { onSuccess: (agent) => onOpen(agent.id) },
              );
            }}
          >
            {hire.isPending ? "正在启用…" : "启用"}
          </Button>
        </>
      )}
    </Card>
  );
}
