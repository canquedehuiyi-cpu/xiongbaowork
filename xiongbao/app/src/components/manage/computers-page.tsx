import {
  IconAlertTriangle,
  IconBolt,
  IconDeviceDesktop,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { shortName } from "@/lib/brand";
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import {
  type ComputerProfile,
  computerFleetQueryOptions,
} from "@/lib/computers/queries";
import { useManagePaths } from "@/lib/manage-paths";
import type { SectionAudience } from "@/lib/settings/audience";

/** One row's identity: the computer, and on a shared computer the Bot's seat on it. */
function rowId(computer: ComputerProfile): string {
  return `${computer.computer}|${computer.botId ?? ""}`;
}

const PERSONAL: SectionAudience = { who: "everyone", edition: "personal" };
const TEAM_ADMIN: SectionAudience = { who: "team-admin", edition: "team" };

const FOLDERS_DESCRIPTION = () =>
  `选择员工可以读取的这台电脑上的文件夹。每次改文件或运行命令前，桌面应用都会先问你。退出${shortName()}后访问就结束。`;

/**
 * 电脑与设备（`/settings/devices`）里个人版的两节：◆ 你的员工的浏览器（`#this-computer`）和
 * ◆ 这台电脑上的文件夹。个人版是一个人的一台电脑，团队才用得上的东西（给每人一台电脑的提示、一行是谁的座位、
 * 从哪出网）不画；每位员工的浏览器留着「停止」和「重置」，这是这个人让员工退出所有登录的唯一地方。
 *
 * 受众判断在 `SettingsSection` 里：读完受众之前、以及团队版，都不画，也不发读取。
 */
export function ThisComputerSections() {
  return (
    <>
      <SettingsSection
        audience={PERSONAL}
        description="你的员工共用一台电脑。每位员工在上面有自己的浏览器资料，所以能保持登录。但一位员工运行的命令仍能读到另一位员工的文件。"
        id="this-computer"
        title="你的员工的浏览器"
      >
        <ComputerList personal />
      </SettingsSection>
      <SettingsSection
        audience={PERSONAL}
        description={FOLDERS_DESCRIPTION()}
        id="this-computer-folders"
        title="这台电脑上的文件夹"
      >
        <HostFolders personal />
      </SettingsSection>
    </>
  );
}

/**
 * 电脑与设备里团队版管理员的一节：★ 团队的电脑（`#team-computers`）。这个部署里的电脑（停止浏览器、重置、
 * 更新电脑），以及这台电脑上的文件夹（每位员工的授权）。原来是「管理 › 电脑」一整页。
 */
export function TeamComputersSection() {
  return (
    <SettingsSection
      audience={TEAM_ADMIN}
      description="每个人的电脑，以及每位独立员工的电脑。每位员工在上面有自己的浏览器资料，所以能保持登录。重置一台电脑会让上面每位员工退出所有登录。"
      id="team-computers"
      title="团队的电脑"
    >
      <SubHeading first>这个部署里的电脑</SubHeading>
      <ComputerList personal={false} />
      <SubHeading>这台电脑上的文件夹</SubHeading>
      <p className="mt-1 text-pretty text-muted-foreground text-sm leading-relaxed">
        {FOLDERS_DESCRIPTION()}
      </p>
      <HostFolders personal={false} />
    </SettingsSection>
  );
}

/** 一节里的小标题：团队的电脑一节有两块，各自一个名字，不另开一节（一节一种受众，§5.1）。 */
function SubHeading({
  children,
  first = false,
}: {
  children: ReactNode;
  first?: boolean;
}) {
  /*
   * 节奏表（xiongbao-screen-layout）：标题块到内容 16px，所以第一个小标题紧跟节的描述用 mt-4；第二块是另一组
   * 互不相干的操作，取表里「节到节」的 48px，眼睛不会把两块连成一片。
   */
  return (
    <h3
      className={
        first ? "mt-4 font-medium text-sm" : "mt-12 font-medium text-sm"
      }
    >
      {children}
    </h3>
  );
}

/**
 * The computers, each with Stop, Reset and (on an old image) Update. `personal` is the personal
 * edition: one person's one computer, so a row is one of their Bots.
 */
function ComputerList({ personal }: { personal: boolean }) {
  const paths = useManagePaths();
  /** The row currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profiles, so it requires confirmation. */
  const [confirming, setConfirming] = useState<ComputerProfile | null>(null);
  /** Updating restarts a running computer mid-task, so it is confirmed too. */
  const [confirmingUpdate, setConfirmingUpdate] =
    useState<ComputerProfile | null>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));

  const computers = fleet.data?.computers ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * A list that could not be read. A refused stop, reset or update is said beside the buttons
   * instead, because the top of this page is a long scroll away from them.
   */
  const problem = fleet.error ? "读不到电脑列表。请刷新页面。" : null;

  const run = (
    computer: ComputerProfile,
    action: "stop" | "reset" | "update",
  ) => {
    setBusy(rowId(computer));
    setConfirming(null);
    setConfirmingUpdate(null);
    setState.mutate(
      {
        action,
        computer: computer.computer,
        ...(computer.botId ? { botId: computer.botId } : {}),
      },
      { onSettled: () => setBusy(null) },
    );
  };

  /**
   * Whose computer a row is, in the words the rest of Admin uses.
   *
   * A person's computer is named for the person. An isolated Bot's is named for the Bot. On a shared
   * computer a row is one person's seat on one Bot, so it names both.
   */
  const titleOf = (computer: ComputerProfile): string => {
    // One person, so a row is one of their Bots.
    if (personal) return computer.botId ? nameFor(computer.botId) : "电脑";
    // fork 原有：一行没带这个人是谁时写「某个人」，不写出 undefined。
    const person =
      computer.person?.name ??
      computer.person?.email ??
      computer.personId ??
      "某个人";
    if (computer.kind === "person") {
      return computer.botId
        ? `${person} · ${nameFor(computer.botId)}`
        : `${person} 的电脑`;
    }
    return computer.botId ? nameFor(computer.botId) : computer.computer;
  };

  /** What a row carries, said once before its state. */
  const scopeOf = (computer: ComputerProfile): string => {
    if (computer.kind === "person") {
      return computer.botId
        ? "这个人为这位员工保留的浏览器资料和文件夹"
        : "运行这个人用的每一位员工";
    }
    return isolation === "shared"
      ? "每个人有自己的资料之前，这位员工的浏览器资料"
      : "独立：有自己的一台电脑，用它的人共用";
  };

  /** Whether its browser runs, and when it starts again. */
  const stateOf = (computer: ComputerProfile): string => {
    const since = computer.running
      ? `浏览器从 ${new Date(computer.startedAt ?? "").toLocaleTimeString("zh-CN")} 起在运行`
      : "没有浏览器在运行";
    return computer.running ? since : `${since}。员工下次需要时会启动。`;
  };

  return (
    <>
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {personal ? null : isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">所有人的员工都在一台电脑上运行。</span>
          每个人为每位员工保留自己的浏览器资料和文件夹，所以登录不会共用；但一位员工运行的命令仍能读到别人的文件。设置{" "}
          <code>COMPUTER_SUPERVISOR_URL</code> 可以让每个人有自己的电脑。
        </p>
      ) : isolation === "per-person" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          每个人有自己的电脑，他用的每位员工（包括别人做的公开员工）都在上面运行。每位员工在上面有自己的浏览器资料和文件夹，但一位员工运行的命令能碰到这个人电脑上的其他东西。独立员工有自己的电脑。
        </p>
      ) : null}

      {setState.error ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {setState.error.message}
        </p>
      ) : null}
      {computers === null && problem ? (
        <PageEmpty icon={IconAlertTriangle} title="读不到列表" />
      ) : computers === null ? null : computers.length === 0 ? (
        <PageEmpty
          icon={IconDeviceDesktop}
          title={personal ? "还没有浏览器" : "还没有电脑"}
        >
          {personal
            ? "员工第一次打开网页时会启动一个。"
            : "员工第一次打开网页时会出现一台。"}
        </PageEmpty>
      ) : (
        <PageRows>
          {computers.map((computer, index) => (
            <StaggerItem index={index} key={rowId(computer)}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle title={computer.computer}>
                    {titleOf(computer)}
                  </ItemTitle>
                  <ItemDescription>
                    {personal ? null : `${scopeOf(computer)} · `}
                    {stateOf(computer)}
                    {personal
                      ? null
                      : ` · ${
                          computer.egress === undefined
                            ? "没有报告出口"
                            : computer.egress === null
                              ? "直接出网"
                              : `经 ${computer.egress} 出网`
                        }`}
                    {computer.updateAvailable ? " · 有可用更新" : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {computer.updateAvailable ? (
                    <Button
                      disabled={busy === rowId(computer)}
                      onClick={() => setConfirmingUpdate(computer)}
                      size="sm"
                      variant="outline"
                    >
                      更新电脑
                    </Button>
                  ) : null}
                  <Button
                    disabled={busy === rowId(computer) || !computer.running}
                    onClick={() => void run(computer, "stop")}
                    size="sm"
                    variant="outline"
                  >
                    {busy === rowId(computer) ? "正在处理…" : "停止浏览器"}
                  </Button>
                  <Button
                    disabled={busy === rowId(computer)}
                    onClick={() => setConfirming(computer)}
                    size="sm"
                    variant="outline"
                  >
                    重置
                  </Button>
                </ItemActions>
              </Item>
              {index !== computers.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names whose computer it is, so the sentence somebody
       * agrees to says which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {personal
                ? confirming?.botId
                  ? `重置 ${nameFor(confirming.botId)} 的浏览器？`
                  : "重置这台电脑？"
                : `重置 ${confirming ? titleOf(confirming) : ""}？`}
            </DialogTitle>
            <DialogDescription>
              {confirming?.kind === "person" && !confirming.botId
                ? "这个人电脑上每位员工的浏览器资料都会被删除，每位员工都会退出所有服务，从头开始。"
                : "它的浏览器资料会被删除，这位员工会退出所有服务，从头开始。"}
              这一步不能撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={confirming !== null && busy === rowId(confirming)}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {confirming !== null && busy === rowId(confirming)
                ? "正在重置…"
                : "重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingUpdate(null);
        }}
        open={confirmingUpdate !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              更新 {confirmingUpdate ? titleOf(confirmingUpdate) : ""}？
            </DialogTitle>
            <DialogDescription>
              它会换到{paths.deploymentName}
              现在用的电脑镜像，文件和登录都会保留。如果它正在运行，会重启并停下手上的事。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmingUpdate(null)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={
                confirmingUpdate !== null && busy === rowId(confirmingUpdate)
              }
              onClick={() => {
                if (confirmingUpdate) void run(confirmingUpdate, "update");
              }}
              size="sm"
            >
              {confirmingUpdate !== null && busy === rowId(confirmingUpdate)
                ? "正在更新…"
                : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {personal ? (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>停止浏览器</strong>会关掉浏览器但保留登录，下次需要时再启动。
          <strong>重置</strong>会删除员工的浏览器资料，让它退出所有登录。
          每一项都会记在
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          里。
        </p>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>停止</strong>
          会关掉电脑上的浏览器但保留登录，员工下次需要时再启动。
          <strong>重置</strong>
          会删除浏览器资料，让上面每位员工退出所有登录。电脑用的是旧镜像时会出现
          <strong>更新电脑</strong>
          ，它会把电脑换到新镜像，保留文件和登录。这三项都会记在
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          里。
        </p>
      )}
    </>
  );
}

/** The folders on this computer each Bot may read, with the reads and writes still open. */
function HostFolders({ personal }: { personal: boolean }) {
  const queryClient = useQueryClient();
  const nameFor = useBotNames();
  const hostAccess = useQuery(hostAccessQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );
  const hostProblem = hostAccess.error
    ? hostAccess.error.message
    : requestGrant.error
      ? requestGrant.error.message
      : revokeGrant.error
        ? revokeGrant.error.message
        : stopHostAccess.error
          ? stopHostAccess.error.message
          : null;

  return (
    <HostFoldersSection
      connected={hostAccess.data?.connected ?? false}
      desktop={hostAccess.data?.desktop !== false}
      grants={hostAccess.data?.grants ?? []}
      botIds={(agents.data ?? []).map((agent) => agent.id)}
      loading={hostAccess.isPending || agents.isPending}
      nameFor={nameFor}
      onGrant={(botId) => requestGrant.mutate({ botId })}
      onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
      onStop={() => stopHostAccess.mutate()}
      pending={hostAccess.data?.pending ?? []}
      personal={personal}
      problem={hostProblem}
      requestingBotId={
        requestGrant.isPending ? (requestGrant.variables?.botId ?? null) : null
      }
      revokingGrantId={
        revokeGrant.isPending ? (revokeGrant.variables?.grantId ?? null) : null
      }
      stopping={stopHostAccess.isPending}
    />
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  /** This XiongBao runs in XiongBao Desktop. Without it no folder can ever be chosen here. */
  desktop: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  /**
   * The personal edition, where the person reading is the one XiongBao Desktop asks. In the team
   * edition the desktop's owner may be somebody else, so a waiting request names them instead.
   */
  personal: boolean;
  problem: string | null;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  desktop,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  personal,
  problem,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const paths = useManagePaths();
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      // Stop folder access is addressed to every Bot ("*"), not one: it is no Bot's row.
      ...pending.map((one) => one.botId).filter((botId) => botId !== ALL_BOTS),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <>
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {desktop && !connected && !loading ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          桌面应用不在线。打开它才能批准文件夹或运行命令。
        </p>
      ) : null}

      {loading ? null : !desktop ? (
        <PageEmpty icon={IconDeviceDesktop} title={`需要${shortName()}桌面版`}>
          这里的{shortName()}不是在桌面应用里运行的。用{shortName()}
          桌面版才能让员工读取这台电脑上的文件夹。
        </PageEmpty>
      ) : botIds.length === 0 ? (
        <PageEmpty icon={IconBolt} title="还没有员工">
          先新建一位员工，再给它选文件夹。
        </PageEmpty>
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{nameFor(botId)}</ItemTitle>
                  <ItemDescription>
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
                    personal={personal}
                    revokingGrantId={revokingGrantId}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={!connected || requestingBotId === botId}
                    onClick={() => onGrant(botId)}
                    size="sm"
                    variant="outline"
                  >
                    {requestingBotId === botId ? "正在等待…" : "选择文件夹"}
                  </Button>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      {desktop ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
          <p>文件夹是只读的。员工需要写入时，桌面应用会先问你。</p>
          <div className="flex items-center gap-3">
            <Button
              disabled={!connected || stopping}
              onClick={onStop}
              size="sm"
              variant="outline"
            >
              {stopping ? "正在停止…" : "停止文件夹访问"}
            </Button>
            <Link className="underline" {...paths.audit()}>
              打开{paths.auditLabel}
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  personal,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
  personal: boolean;
  revokingGrantId: string | null;
}) {
  const botGrants = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const botPending = pending.filter((request) => request.botId === botId);

  if (botGrants.length === 0 && botPending.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {botGrants.map((grant) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          key={grant.id}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{grant.displayName}</p>
            <p className="text-muted-foreground text-xs">
              {personal ? "只读" : `由${ownerLabel(grant)}批准 · 只读`}
            </p>
          </div>
          <Button
            disabled={revokingGrantId === grant.id}
            onClick={() => onRevoke(grant.id)}
            size="sm"
            variant="ghost"
          >
            {revokingGrantId === grant.id ? "正在撤销…" : "撤销"}
          </Button>
        </div>
      ))}
      {botPending.map((request) => (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          key={request.operationId}
        >
          {pendingSentence(request, personal)}
          {/* fork 原有：写出这个请求涉及的文件夹、文件或命令，管理员才知道在等的是哪一件。 */}
          {request.displayName ? (
            <p className="truncate text-muted-foreground text-xs">
              {request.displayName}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  botId: string,
  grants: HostFolderGrant[],
  pending: HostAccessPendingOperation[],
) {
  const active = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  ).length;
  const waiting = pending.filter((request) => request.botId === botId).length;
  const parts = [];
  if (active > 0) parts.push(`${active} 个只读文件夹`);
  if (waiting > 0) parts.push(`${waiting} 个待处理的请求`);
  return parts.length > 0 ? parts.join(" · ") : "没有批准任何文件夹。";
}

/** The Bot id Stop folder access is addressed to: every Bot at once. */
const ALL_BOTS = "*";

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? "桌面应用的主人";
}

/**
 * What a folder request still open is waiting on, as a sentence.
 *
 * Reading and listing need nobody's answer, so they say only what is happening. A folder, a file
 * change or a command waits for the person at the computer: in the personal edition that is the
 * person reading, so it says XiongBao Desktop is asking them, in a window. It used to say "waiting for
 * approval from the desktop owner" to the desktop's owner, and "Listing files from the desktop owner".
 */
function pendingSentence(
  request: HostAccessPendingOperation,
  personal: boolean,
): string {
  switch (request.kind) {
    case "list_files":
      return "正在列出文件。";
    case "read_file":
      return "正在读一个文件。";
    case "cancel":
    case "stop":
      return "正在停止文件夹里的工作。";
  }
  if (personal) {
    switch (request.kind) {
      case "write_file":
        return `有一处文件改动在等你。${shortName()}桌面版正在弹窗问你。`;
      case "run_command":
        return `有一条命令在等你或还在运行。${shortName()}桌面版会弹窗问你。`;
      default:
        return `有一个文件夹访问在等你。${shortName()}桌面版正在弹窗问你。`;
    }
  }
  const owner = ownerLabel(request);
  switch (request.kind) {
    case "write_file":
      return `文件改动在等${owner}批准，或者还没做完。`;
    case "run_command":
      return `命令在等${owner}批准，或者还没做完。`;
    default:
      return `文件夹访问在等${owner}批准。`;
  }
}
