import { DOESNT_UPDATE_ITSELF } from "@openbot/shared/desktop-updates";
import {
  IconBox,
  IconBrandDocker,
  IconCpu,
  IconFileText,
  IconFolder,
  IconInfoCircle,
  IconSparkles,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { describe } from "@/components/layout/update-banner";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { shortName } from "@/lib/brand";
import {
  checkAppUpdateMutationOptions,
  installAppUpdateMutationOptions,
  intelligenceMutationOptions,
  openLogFolderMutationOptions,
  restartOpenBotMutationOptions,
  stopOpenBotMutationOptions,
} from "@/lib/desktop/mutations";
import { type PartGroup, partLabel } from "@/lib/desktop/part-names";
import {
  type DesktopAppUpdateCheck,
  type DesktopPart,
  type DesktopStatus,
  desktopAppUpdateQueryOptions,
  desktopStatusQueryOptions,
  diagnostics,
  formatBytes,
  type IntelligenceReadiness,
  intelligenceReadinessQueryOptions,
  totalMemory,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/this-computer")({
  component: ComputerPage,
});

const READINESS: Record<IntelligenceReadiness, string> = {
  ready: "就绪",
  starting: "正在启动",
  stopped: "已停止",
  degraded: "部分不可用",
  unknown: "运行中",
};

/**
 * What OpenBot runs on this computer, what each part costs in memory, and Restart and Stop for each.
 *
 * Only inside OpenBot Desktop: the desktop app is what can see and control the containers, Docker and
 * the local Intelligence stack. In a browser there is nothing here to read.
 */
function ComputerPage() {
  const inDesktop = desktopShell() !== null;
  return (
    <PageShell
      description={`${shortName()}在这台电脑上运行了哪些部分、各占多少内存。哪个部分卡住了，就重启它。`}
      title="这台电脑"
    >
      {inDesktop ? (
        <ComputerSections />
      ) : (
        <PageSection>
          <PageEmpty>这个页面只在{shortName()}桌面端里提供。</PageEmpty>
        </PageSection>
      )}
    </PageShell>
  );
}

function ComputerSections() {
  // The quick read draws the page at once; the measured one fills the memory figures in after.
  const listed = useQuery(desktopStatusQueryOptions({ memory: false }));
  const measured = useQuery(desktopStatusQueryOptions({ memory: true }));
  const data = measured.data ?? listed.data;
  const readiness = useQuery({
    ...intelligenceReadinessQueryOptions(),
    enabled: Boolean(data?.intelligenceStack),
  });

  if (!data && (listed.isPending || measured.isPending)) return null;
  if (!data)
    return (
      <p className="text-destructive text-sm" role="alert">
        读不到{shortName()}在这台电脑上运行了什么。
      </p>
    );
  const isMeasured = measured.data !== undefined;
  return (
    <>
      <OpenBotSection measured={isMeasured} status={data} />
      {data.intelligenceStack && (
        <IntelligenceSection
          measured={isMeasured}
          readiness={readiness.data}
          status={data}
        />
      )}
      <MachineSection readiness={readiness.data} status={data} />
    </>
  );
}

function OpenBotSection({
  measured,
  status,
}: {
  /** Container memory has been read; before that a total would count the processes alone. */
  measured: boolean;
  status: DesktopStatus;
}) {
  const restart = useMutation(restartOpenBotMutationOptions(queryClient));
  const stop = useMutation(stopOpenBotMutationOptions());
  const memory = totalMemory([...status.processes, ...status.containers]);
  const busy = restart.isPending || stop.isPending;
  return (
    <PageSection title="应用">
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconCpu className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>{status.openbotRunning ? "运行中" : "已停止"}</ItemTitle>
            <ItemDescription>
              {restart.isPending
                ? "正在重启…"
                : stop.isPending
                  ? "正在停止…"
                  : [
                      // Nothing until the containers are measured: a total of the processes alone
                      // would be a smaller number that then jumps.
                      !measured
                        ? null
                        : memory !== null
                          ? `占用 ${formatBytes(memory)}`
                          : "量不出内存占用。",
                      // Restart is the desktop app's supervisor bringing its own processes back.
                      status.openbotRunning && !status.openbotHeld
                        ? "它在桌面端上次打开之前就已启动。要重启，请先停止再重新启动。"
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
            </ItemDescription>
          </ItemContent>
          {status.openbotRunning && (
            <ItemActions>
              {status.openbotHeld && (
                <Button
                  disabled={busy}
                  onClick={() => restart.mutate()}
                  size="sm"
                  variant="outline"
                >
                  重启
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() => stop.mutate()}
                size="sm"
                variant="outline"
              >
                停止
              </Button>
            </ItemActions>
          )}
        </Item>
        <PartRows
          group="bots"
          icon={IconTerminal2}
          parts={status.processes}
          separatorFirst
        />
        <PartRows
          group="bots"
          icon={IconBox}
          parts={status.containers}
          separatorFirst
        />
      </PageRows>
    </PageSection>
  );
}

function IntelligenceSection({
  measured,
  readiness,
  status,
}: {
  /** Container memory has been read. */
  measured: boolean;
  readiness: IntelligenceReadiness | undefined;
  status: DesktopStatus;
}) {
  const intelligence = useMutation(intelligenceMutationOptions(queryClient));
  const running =
    status.intelligenceContainers.length > 0 && readiness !== "stopped";
  const memory = totalMemory(status.intelligenceContainers);
  return (
    <PageSection
      description={`保存员工的对话和技能。${shortName()}运行时会用到它。`}
      title="后端"
    >
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconSparkles className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>
              {running ? READINESS[readiness ?? "unknown"] : "已停止"}
            </ItemTitle>
            <ItemDescription>
              {intelligence.isPending
                ? intelligence.variables === "start"
                  ? "正在启动…"
                  : "正在停止…"
                : intelligence.error
                  ? intelligence.error.message
                  : !running
                    ? "停止时不占内存。"
                    : !measured
                      ? null
                      : memory !== null
                        ? `占用 ${formatBytes(memory)}`
                        : "量不出内存占用。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {running ? (
              <>
                <Button
                  disabled={intelligence.isPending}
                  onClick={async () => {
                    await intelligence.mutateAsync("stop");
                    intelligence.mutate("start");
                  }}
                  size="sm"
                  variant="outline"
                >
                  重启
                </Button>
                <Button
                  disabled={intelligence.isPending}
                  onClick={() => intelligence.mutate("stop")}
                  size="sm"
                  variant="outline"
                >
                  停止
                </Button>
              </>
            ) : (
              <Button
                disabled={intelligence.isPending}
                onClick={() => intelligence.mutate("start")}
                size="sm"
                variant="outline"
              >
                启动
              </Button>
            )}
          </ItemActions>
        </Item>
        <PartRows
          group="back-end"
          icon={IconBox}
          parts={status.intelligenceContainers}
          separatorFirst
        />
      </PageRows>
    </PageSection>
  );
}

function MachineSection({
  readiness,
  status,
}: {
  readiness: IntelligenceReadiness | undefined;
  status: DesktopStatus;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <PageSection
      action={
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(diagnostics(status, readiness));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
          size="sm"
          variant="outline"
        >
          {copied ? "已复制" : "复制诊断信息"}
        </Button>
      }
      title="详情"
    >
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconBrandDocker className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>
              {status.engine === "podman" ? "Podman" : "Docker"}
            </ItemTitle>
          </ItemContent>
          <ItemActions>
            <span className="text-muted-foreground text-sm">
              {status.engine ? "运行中" : "未运行"}
            </span>
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <RowMark>
            <IconFolder className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>安装位置</ItemTitle>
            <ItemDescription className="line-clamp-none break-all">
              {status.root}
            </ItemDescription>
          </ItemContent>
        </Item>
        {status.logFolder && (
          <>
            <Separator />
            <LogsRow folder={status.logFolder} />
          </>
        )}
        <Separator />
        <VersionRow status={status} />
      </PageRows>
    </PageSection>
  );
}

/**
 * Where the desktop app keeps its log, with Open log folder, so a person can share the file when
 * they ask for help. The desktop app opens its own folder; nothing here names a path to open.
 */
function LogsRow({ folder }: { folder: string }) {
  const open = useMutation(openLogFolderMutationOptions());
  return (
    <Item size="sm">
      <RowMark>
        <IconFileText className="size-4" />
      </RowMark>
      <ItemContent>
        <ItemTitle>日志</ItemTitle>
        <ItemDescription className="line-clamp-none">
          日志只保存在这台电脑上，不含你的密钥和消息。求助时可以把它发给对方。
        </ItemDescription>
        <ItemDescription className="line-clamp-none break-all">
          {folder}
        </ItemDescription>
        {open.error && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            没能打开日志文件夹。请按上面的路径找到它。
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          disabled={open.isPending}
          onClick={() => open.mutate()}
          size="sm"
          variant="outline"
        >
          打开日志文件夹
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * The desktop app's version, with Check for updates. The same check as Check for Updates… in the
 * tray: the app reads its update feed at once and says what it found. On Windows, which has no menu
 * bar, this and the tray are the places to ask.
 *
 * A build that never updates itself (internal, candidate, or without the updater) says so up front
 * in the setup window's words, with no button: the tray and the menus don't offer the check either.
 */
function VersionRow({ status }: { status: DesktopStatus }) {
  const check = useMutation(checkAppUpdateMutationOptions(queryClient));
  const install = useMutation(installAppUpdateMutationOptions(queryClient));
  // The download's progress, asked twice a second from the click on, as the banner asks once it
  // sees an install under way.
  const offer = useQuery({
    ...desktopAppUpdateQueryOptions(),
    refetchInterval: install.isPending ? 500 : false,
  });
  const progress = offer.data?.installing ?? null;
  const installing = install.isPending || progress !== null;
  const found = check.data;
  // An older desktop app doesn't say, and its check answers for itself. No button until the first
  // answer, so a build that doesn't update itself never shows one for a moment.
  const updatesItself = offer.data?.updatesItself !== false;
  return (
    <Item size="sm">
      <RowMark>
        <IconInfoCircle className="size-4" />
      </RowMark>
      <ItemContent>
        <ItemTitle>版本 {status.version}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {status.build}
        </ItemDescription>
        {!updatesItself && (
          <ItemDescription className="line-clamp-none text-foreground">
            {DOESNT_UPDATE_ITSELF}
          </ItemDescription>
        )}
        {found && !check.isPending && (
          <ItemDescription
            className="line-clamp-none text-foreground"
            role="status"
          >
            {checked(found)}
          </ItemDescription>
        )}
        {check.error && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            {reason(check.error)}
          </ItemDescription>
        )}
        {install.error && !installing && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            没能安装更新：{reason(install.error)}
          </ItemDescription>
        )}
      </ItemContent>
      {updatesItself && !offer.isLoading && (
        <ItemActions>
          {found?.found === "available" ? (
            <Button
              disabled={installing}
              onClick={() => install.mutate()}
              size="sm"
            >
              {installing ? describe(progress) : "更新并重启"}
            </Button>
          ) : (
            <Button
              disabled={check.isPending}
              onClick={() => check.mutate()}
              size="sm"
              variant="outline"
            >
              {check.isPending ? "正在检查…" : "检查更新"}
            </Button>
          )}
        </ItemActions>
      )}
    </Item>
  );
}

/** What a check found, in a sentence. */
function checked(found: DesktopAppUpdateCheck): string {
  switch (found.found) {
    case "available":
      return `${shortName()} ${found.version} 已发布。`;
    case "upToDate":
      return `${shortName()} ${found.current} 已是最新版本。`;
    case "installing":
      return `${shortName()}正在下载 ${found.version}，下载完会自动重启。`;
    case "notOffered":
      return DOESNT_UPDATE_ITSELF;
  }
}

/** The desktop app refuses with its own sentence, as a plain string. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each container or process as a read-only row: what it is for, and its memory as the value. */
function PartRows({
  icon: Icon,
  parts,
  group,
  separatorFirst = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  parts: DesktopPart[];
  group: PartGroup;
  separatorFirst?: boolean;
}) {
  return parts.map((part, index) => (
    <React.Fragment key={part.name}>
      {(separatorFirst || index > 0) && <Separator />}
      <Item size="sm">
        <RowMark>
          <Icon className="size-4" />
        </RowMark>
        <ItemContent>
          <ItemTitle className="font-normal">
            {partLabel(part.name, group)}
          </ItemTitle>
        </ItemContent>
        <ItemActions>
          <span className="text-muted-foreground text-sm tabular-nums">
            {part.memoryBytes === null ? "—" : formatBytes(part.memoryBytes)}
          </span>
        </ItemActions>
      </Item>
    </React.Fragment>
  ));
}
