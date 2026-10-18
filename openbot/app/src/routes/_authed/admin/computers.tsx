import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
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
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import { computerFleetQueryOptions } from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Updating restarts a running computer mid-task, so it is confirmed too. */
  const [confirmingUpdate, setConfirmingUpdate] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const hostAccess = useQuery(hostAccessQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );

  const computers = fleet.data?.computers ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * A list that could not be read. A refused stop, reset or update is said beside the buttons
   * instead, because the top of this page is a long scroll away from them.
   */
  const problem = fleet.error ? "读不到电脑列表。" : null;
  const hostProblem = hostAccess.error
    ? hostAccess.error.message
    : requestGrant.error
      ? requestGrant.error.message
      : revokeGrant.error
        ? revokeGrant.error.message
        : stopHostAccess.error
          ? stopHostAccess.error.message
          : null;

  const run = (botId: string, action: "stop" | "reset" | "update") => {
    setBusy(botId);
    setConfirming(null);
    setConfirmingUpdate(null);
    setState.mutate({ action, botId }, { onSettled: () => setBusy(null) });
  };

  return (
    <PageShell
      description="每位员工的浏览器以及它保留的配置文件。配置文件让员工明天还保持登录；重置会让它从所有服务里退出登录。"
      title="电脑"
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">所有员工在共用一台电脑。</span>{" "}
          它们共享登录状态、文件和会话，所以一位员工能碰到另一位员工登录过的东西。设置{" "}
          <code>COMPUTER_SUPERVISOR_URL</code> 可以让每位员工各用一台。
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          每位员工都有自己的电脑：自己的容器、自己的文件和自己的浏览器配置文件。
        </p>
      ) : null}

      <HostFoldersSection
        connected={hostAccess.data?.connected ?? false}
        grants={hostAccess.data?.grants ?? []}
        botIds={(agents.data ?? []).map((agent) => agent.id)}
        loading={hostAccess.isPending || agents.isPending}
        nameFor={nameFor}
        onGrant={(botId) => requestGrant.mutate({ botId })}
        onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
        onStop={() => stopHostAccess.mutate()}
        pending={hostAccess.data?.pending ?? []}
        problem={hostProblem}
        requestingBotId={
          requestGrant.isPending
            ? (requestGrant.variables?.botId ?? null)
            : null
        }
        revokingGrantId={
          revokeGrant.isPending
            ? (revokeGrant.variables?.grantId ?? null)
            : null
        }
        stopping={stopHostAccess.isPending}
      />

      <PageSection title="这个部署里的电脑">
        {setState.error ? (
          <p
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {setState.error.message}
          </p>
        ) : null}
        {computers === null && problem ? (
          <PageEmpty>读不到列表。</PageEmpty>
        ) : computers === null ? null : computers.length === 0 ? (
          <PageEmpty>还没有电脑。员工第一次打开网页时会出现一台。</PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {computer.running
                        ? `浏览器自 ${new Date(computer.startedAt ?? "").toLocaleTimeString("zh-CN")} 起在运行`
                        : "浏览器没有在运行。员工下次需要时会自动启动。"}
                      {" · "}
                      {computer.egress === undefined
                        ? "出口未上报"
                        : computer.egress === null
                          ? "直接出网"
                          : `经 ${computer.egress} 出网`}
                      {computer.updateAvailable ? " · 有可用更新" : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {computer.updateAvailable ? (
                      <Button
                        disabled={busy === computer.botId}
                        onClick={() => setConfirmingUpdate(computer.botId)}
                        size="sm"
                        variant="outline"
                      >
                        更新电脑
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId ? "处理中…" : "停止浏览器"}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
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
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
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
              重置 {confirming ? nameFor(confirming) : ""} 的电脑？
            </DialogTitle>
            <DialogDescription>
              它的配置文件会被删除，员工会从所有登录过的服务里退出，从头开始。此操作无法撤销。
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
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? "正在重置…" : "重置"}
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
              更新 {confirmingUpdate ? nameFor(confirmingUpdate) : ""} 的电脑？
            </DialogTitle>
            <DialogDescription>
              它会换到这个部署当前使用的电脑镜像上，文件和登录状态都会保留。如果正在运行，它会重启，正在做的事会被打断。
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
              disabled={busy === confirmingUpdate}
              onClick={() => {
                if (confirmingUpdate) void run(confirmingUpdate, "update");
              }}
              size="sm"
            >
              {busy === confirmingUpdate ? "正在更新…" : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        <strong>停止</strong>
        会关闭浏览器并保留登录状态，员工下一步操作时会从原处接着开。
        <strong>重置</strong>会删除配置文件，员工从所有服务里退出、从头开始。
        当某台电脑的镜像比这个部署旧时会出现<strong>更新电脑</strong>
        ，它会把电脑换到新镜像上，文件和登录状态都保留。这三种操作都会记录在
        <Link className="underline" to="/admin/audit">
          审计
        </Link>
        里。
      </p>
    </PageShell>
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  problem: string | null;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  problem,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      ...pending.map((one) => one.botId),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <PageSection
      description="选择员工可以在这台电脑上读取的文件夹。每次修改文件或执行命令前，桌面应用都会先询问。停止应用后访问即结束。"
      title="这台电脑上的文件夹"
    >
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {!connected && !loading ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          桌面应用离线了。文件夹只能在桌面应用里批准，离线期间也无法执行命令。
        </p>
      ) : null}

      {loading ? null : botIds.length === 0 ? (
        <PageEmpty>还没有员工。先创建一位员工，再选择文件夹。</PageEmpty>
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle title={botId}>{nameFor(botId)}</ItemTitle>
                  <ItemDescription>
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
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
                    {requestingBotId === botId ? "等待中…" : "选择文件夹"}
                  </Button>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
        <p>授权默认只读。员工需要写入时，会通过桌面应用的系统弹窗申请。</p>
        <div className="flex items-center gap-3">
          <Button
            disabled={!connected || stopping}
            onClick={onStop}
            size="sm"
            variant="outline"
          >
            {stopping ? "正在停止…" : "停止文件夹访问"}
          </Button>
          <Link className="underline" to="/admin/audit">
            查看审计
          </Link>
        </div>
      </div>
    </PageSection>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
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
              {ownerLabel(grant)} · 只读
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
          {pendingLabel(request)}，来自 {ownerLabel(request)}
          {request.displayName ? `，对象 ${request.displayName}` : ""}。
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
  if (waiting > 0) parts.push(`${waiting} 个待处理请求`);
  return parts.length > 0 ? parts.join(" · ") : "没有已批准的文件夹。";
}

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? "桌面应用的主人";
}

function pendingLabel(request: HostAccessPendingOperation) {
  switch (request.kind) {
    case "write_file":
      return "文件修改等待批准或完成";
    case "run_command":
      return "命令等待批准或完成";
    case "list_files":
      return "正在列出文件";
    case "read_file":
      return "正在读取文件";
    case "cancel":
    case "stop":
      return "正在停止文件夹操作";
    default:
      return "文件夹访问等待批准";
  }
}
