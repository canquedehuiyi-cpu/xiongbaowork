import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AppOpenButton } from "@/components/channels/app-open-button";
import { ARTIFACT_DOWNLOAD_LINK } from "@/components/channels/turn-artifacts";
import {
  ApprovalActions,
  useApprovalDecision,
} from "@/components/tasks/approval-actions";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";
import { artifactHref } from "@/lib/computers/artifact";
import { useScheduleZone } from "@/lib/settings/work-hours";
import {
  canExtend,
  canNudge,
  canReassign,
  canTrack,
  clockText,
  deliveryLaneOf,
  dueText,
  type EvidenceRow,
  eventLine,
  eventsInOrder,
  evidenceOf,
  type FollowedCard,
  followedCardQueryOptions,
  formerOverdueMinutes,
  lengthText,
  overdueChip,
  overdueMinutes,
  pendingExtension,
  type TaskEvent,
  taskEventsQueryOptions,
} from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import {
  DeliveryDialogs,
  deliveryButton,
  LastError,
  type OpenDialog,
  TechnicalError,
  TrackButton,
  useDeliveryWrites,
  useWbFallback,
  WriteFailure,
  ZoneNote,
} from "@/skins/xiongbao/delivery-actions";

/**
 * 任务卡详情（交付闭环 Task 8，设计稿 2）：四步进度、交付物与证据、验收标准、验收 / 退回（写原因）/ 取消、
 * 流水（按时间正序，只追加）。员工手上的卡还有「再催一次」「准许延期到……」「换个员工接手」（设计稿 5）。
 * 逾期的卡就是手机上的「逾期页」：「逾期了，怎么办？」下面是服务器替你盯过的经过（流水里的催办、逾期、
 * 通知），和一列四个处理按钮（Task 10）。
 *
 * 在看板上面从右边滑出来（手机上占满一屏），关上回到看板，看板的筛选不变。深链和手机推送也落到这里。
 * 颜色只从 `--wb-*` 令牌取（`skin.css`）；在别的皮肤里打开时，根上把这些令牌接到应用自己的令牌上
 * （`useWbFallback`）。
 */
export const Route = createFileRoute("/_authed/_app/tasks/$taskId")({
  component: TaskDetailPage,
});

/** 详情读到的一张卡：列表里那张，加上它在哪个对话里。 */
type DetailCard = FollowedCard & {
  source?: string;
  open?: { kind: string; id: string } | null;
};

function TaskDetailPage() {
  const { taskId } = Route.useParams();
  const navigate = useNavigate();
  const close = () =>
    void navigate({
      from: Route.fullPath,
      search: (previous) => previous,
      to: "/tasks",
    });
  const fallback = useWbFallback();
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open
    >
      <SheetContent
        className="gap-0 overflow-y-auto border-(--wb-line) bg-(--wb-list) p-0 text-(--wb-fg) data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
        side="right"
        style={fallback}
      >
        <TaskDetail taskId={taskId} />
      </SheetContent>
    </Sheet>
  );
}

const SECTION_TITLE = "m-0 font-semibold text-(--wb-fg) text-[13px]";

type Step = { label: string; sub: string; reached: boolean };

/** 设计稿 2 的四步：做过的打勾，走到的那一步是蓝的，没到的灰着。 */
function Progress({ steps, finished }: { steps: Step[]; finished: boolean }) {
  const current = finished
    ? -1
    : steps.reduce((last, step, index) => (step.reached ? index : last), -1);
  return (
    <ol aria-label="进度" className="m-0 flex list-none gap-1 p-0">
      {steps.map((step, index) => {
        const done = step.reached && index !== current;
        const here = index === current;
        return (
          <li
            aria-current={here ? "step" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-1.5 text-center text-[12px] leading-[1.45]",
              here ? "text-(--wb-fg)" : "text-(--wb-muted)",
            )}
            key={step.label}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-[22px] items-center justify-center rounded-full font-semibold text-[11px]",
                done
                  ? "bg-(--wb-green) text-(--wb-bg)"
                  : here
                    ? "bg-(--wb-blue) text-(--wb-blue-fg)"
                    : "bg-(--wb-card2) text-(--wb-muted)",
              )}
            >
              {done ? "✓" : index + 1}
            </span>
            <span>
              {step.label}
              <br />
              {step.sub}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RowIcon({ kind }: { kind: EvidenceRow["kind"] }) {
  if (kind === "check" || kind === "note")
    return (
      <svg
        aria-hidden="true"
        className="shrink-0 text-(--wb-green)"
        fill="none"
        height="16"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="16"
      >
        <path d="M5 12l4 4 10-10" />
      </svg>
    );
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-(--wb-fg2)"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="16"
    >
      {kind === "link" ? (
        <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
      ) : (
        <path d="M6 3h8l4 4v14H6z" />
      )}
    </svg>
  );
}

const ROW_NOTE: Record<EvidenceRow["kind"], string> = {
  attachment: "附件",
  component: "组件",
  link: "链接",
  workspace_file: "工作区文件",
  app: "程序",
  diff: "改动汇总",
  note: "文字结论",
  check: "员工自查",
};

export function EvidenceLine({
  row,
  taskId,
  agentId,
}: {
  row: EvidenceRow;
  taskId: string;
  /** 卡的负责员工：工作区文件在它的工作区里；没有负责员工就不出下载。 */
  agentId: string | null;
}) {
  const download =
    row.kind === "workspace_file" && agentId
      ? artifactHref({
          botId: agentId,
          path: row.path,
          scope: { task: taskId },
        })
      : undefined;
  const label =
    row.kind === "attachment" ? (
      <a
        className="text-inherit underline-offset-2 hover:underline"
        href={`/api/attachments/${encodeURIComponent(row.id)}`}
        rel="noreferrer"
        target="_blank"
      >
        {row.label}
      </a>
    ) : row.kind === "link" ? (
      <a
        className="text-inherit underline-offset-2 hover:underline"
        href={row.url}
        rel="noreferrer"
        target="_blank"
      >
        {row.label}
      </a>
    ) : (
      row.label
    );
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-(--wb-line) bg-(--wb-card) px-3 py-2.5 text-[13px]">
      <RowIcon kind={row.kind} />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
      {download ? (
        <a className={ARTIFACT_DOWNLOAD_LINK} href={download}>
          下载
        </a>
      ) : null}
      {row.kind === "app" && agentId ? (
        <AppOpenButton
          label={row.label}
          target={{
            botId: agentId,
            app: { port: row.port, path: row.path },
            scope: { task: taskId },
          }}
        />
      ) : null}
      <span className="ml-auto shrink-0 text-(--wb-muted) text-[12px]">
        {row.kind === "diff"
          ? `${row.detail} · ${ROW_NOTE.diff}`
          : row.kind === "workspace_file" && row.unverified
            ? `${ROW_NOTE.workspace_file} · 未核实`
            : row.kind === "app"
              ? `${ROW_NOTE.app} · 端口 ${row.port}${row.unverified ? " · 未核实" : ""}`
              : ROW_NOTE[row.kind]}
      </span>
    </div>
  );
}

/**
 * 逾期卡上「服务器替你盯着」那一段（设计稿 5）：流水里核对器替你做过的事——叫醒员工问进度（第几次）、记为
 * 逾期、通知你（或留到开工清点）。只念流水里真有的行：没人核对过的时段不写成「一直在盯」。你自己点的「再催」
 * 不算在这里（它在下面的流水里）。
 */
function WatchSteps({
  history,
  events,
  now,
  title,
  nameOf,
  agentId,
  timeZone,
}: {
  history: TaskEvent[];
  events: { isError: boolean; isPending: boolean };
  now: Date;
  title: string;
  nameOf: (agentId: string) => string;
  agentId: string | null;
  timeZone?: string;
}) {
  /*
   * 「第 N 次」和上面「已催 N 次」同一个口径：你点的「再催」也算一次（规格第 8 节，它也占当天的 3 次），只是
   * 它不列在这一段里。
   */
  let nudges = 0;
  const steps = history.flatMap((event) => {
    if (event.kind === "nudged") nudges += 1;
    const byServer = !event.actor.startsWith("user:");
    if (
      !(
        (event.kind === "nudged" && byServer) ||
        event.kind === "overdue" ||
        event.kind === "notified"
      )
    )
      return [];
    const line = eventLine(event, { now, title, nameOf, agentId, timeZone });
    if (!line) return [];
    return [
      {
        event,
        text:
          event.kind === "nudged"
            ? `${line.text}（第 ${nudges} 次）`
            : line.text,
      },
    ];
  });
  return (
    <section
      aria-label="服务器替你盯着"
      className="flex flex-col gap-2 rounded-(--wb-radius) bg-(--wb-card) p-3.5"
    >
      <h4 className="m-0 font-semibold text-(--wb-fg2) text-[13px]">
        服务器替你盯着
      </h4>
      {events.isError ? (
        <p className="m-0 text-(--wb-danger-fg) text-[12.5px]" role="alert">
          读不到核对经过，稍后再试。
        </p>
      ) : steps.length === 0 ? (
        <p className="m-0 text-(--wb-muted) text-[12.5px]">
          {events.isPending ? "正在读核对经过…" : "流水里还没有核对记录。"}
        </p>
      ) : (
        <ol className="m-0 grid list-none grid-cols-[minmax(52px,max-content)_minmax(0,1fr)] gap-x-2.5 gap-y-2 p-0 text-[13px] leading-[1.6]">
          {steps.map(({ event, text }) => (
            <li className="contents" key={event.id}>
              <time className="text-(--wb-muted)" dateTime={event.createdAt}>
                {clockText(event.createdAt, now, timeZone)}
              </time>
              <span className="text-(--wb-fg) [overflow-wrap:anywhere]">
                {text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const lastOf = (events: TaskEvent[], kind: string) =>
  events.findLast((event) => event.kind === kind)?.createdAt ?? null;

function TaskDetail({ taskId }: { taskId: string }) {
  const now = new Date();
  const card = useQuery(followedCardQueryOptions<DetailCard>(taskId));
  const events = useQuery(taskEventsQueryOptions(taskId));
  const coworkers = useQuery(agentListQueryOptions());
  const writes = useDeliveryWrites();
  const approval = useApprovalDecision();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // 时刻按作息时区念，和推送、清点、服务器写的提醒同一个钟（作息还没读到时按浏览器的钟）。
  const zone = useScheduleZone();

  if (card.isError)
    return (
      <div className="flex flex-col gap-3 p-6" role="alert">
        <SheetTitle className="m-0 font-semibold text-(--wb-fg) text-[18px]">
          打不开这张任务卡
        </SheetTitle>
        <p className="m-0 text-(--wb-fg2) text-[13px]">
          {card.error instanceof Error ? card.error.message : "请稍后再试。"}
        </p>
      </div>
    );
  if (!card.data)
    return (
      <div className="p-6">
        <SheetTitle className="m-0 font-normal text-(--wb-muted) text-[13px]">
          正在读这张任务卡…
        </SheetTitle>
      </div>
    );

  const task = card.data;
  const nameOf = (id: string) =>
    coworkers.data?.find((coworker) => coworker.id === id)?.name ?? "员工";
  const who = task.executorAgentId ? nameOf(task.executorAgentId) : "员工";
  const history = eventsInOrder(events.data ?? []);
  const lines = history.flatMap((event) => {
    const line = eventLine(event, {
      now,
      title: task.title,
      nameOf,
      agentId: task.executorAgentId,
      timeZone: zone,
    });
    return line ? [{ event, line }] : [];
  });
  const followed = deliveryLaneOf(task) !== null;
  const late = overdueMinutes(task, now);
  const formerly =
    late === null ? formerOverdueMinutes(task, history, now) : null;
  const evidence = evidenceOf(task.deliverableRef);
  const asking = pendingExtension(history);
  const status = task.status;
  const handedIn = status === "awaiting_review" || status === "done";
  const steps: Step[] = [
    {
      label: "派出",
      sub: clockText(
        lastOf(history, "dispatched") ?? task.createdAt ?? task.updatedAt,
        now,
        zone,
      ),
      reached: true,
    },
    {
      label: "已接下",
      sub: task.dueAt
        ? `预计 ${dueText(task.dueAt, now, zone)}`
        : task.acceptedAt
          ? `${clockText(task.acceptedAt, now, zone)} 接下`
          : "—",
      reached: Boolean(task.acceptedAt) || handedIn,
    },
    {
      label: "已交成果",
      sub: handedIn
        ? clockText(lastOf(history, "delivered") ?? task.updatedAt, now, zone)
        : "—",
      reached: handedIn,
    },
    {
      label: "你验收",
      sub:
        status === "done"
          ? clockText(lastOf(history, "reviewed") ?? task.updatedAt, now, zone)
          : "—",
      reached: status === "done",
    },
  ];
  const where =
    task.open?.kind === "group"
      ? { to: "/group/$channelId" as const, label: "来自群组" }
      : task.open?.kind === "channel"
        ? { to: "/channel/$channelId" as const, label: "来自单聊" }
        : null;

  /*
   * 延期弹层要先知道员工有没有待答复的申请：流水读不到时不给打开（提交会绕过那条申请），在按钮旁说一句。
   */
  /*
   * 逾期卡（设计稿 5）：四个处理按钮一个一列、44px 高，「再催一次」是蓝的；别的时候一行排开、手机上一个一列。
   */
  const stacked = late !== null && status === "running";
  const size = stacked ? "lg" : "md";
  const wide = stacked ? "w-full" : "max-sm:w-full";
  const extendButton = (label: string) => (
    <button
      className={cn(deliveryButton(false, size), wide)}
      disabled={events.isError || events.isPending}
      onClick={() => setDialog({ kind: "extend", card: task })}
      title={events.isError ? "读不到流水，稍后再试" : undefined}
      type="button"
    >
      {label}
    </button>
  );
  const cancelButton = (
    <button
      className={cn(
        deliveryButton(false, size),
        wide,
        stacked ? null : "sm:ml-auto",
      )}
      disabled={writes.busy.has(task.id)}
      onClick={() => {
        if (!confirmCancel) {
          setConfirmCancel(true);
          return;
        }
        setConfirmCancel(false);
        writes.run(task, "cancel");
      }}
      type="button"
    >
      {confirmCancel ? "确定取消？再点一下" : "取消这件活"}
    </button>
  );

  let actions: ReactNode = null;
  if (followed && status === "awaiting_review")
    actions = (
      <div className="flex flex-wrap gap-2">
        <button
          className={deliveryButton(true, "md")}
          disabled={writes.busy.has(task.id)}
          onClick={() => writes.run(task, "review")}
          type="button"
        >
          验收
        </button>
        <button
          className={deliveryButton(false, "md")}
          onClick={() => setDialog({ kind: "return", card: task })}
          type="button"
        >
          退回，写原因
        </button>
        {cancelButton}
      </div>
    );
  else if (followed && status === "needs_action")
    /*
     * 等你审批或回答：在这里直接批准 / 拒绝 / 回答（和看板「待关注」同一套），处理完员工接着做。这时服务器
     * 不让催、不让换人；已接下的卡还能改预计时间。
     */
    actions = (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-(--wb-amber-fg) text-[13px]">
          等你操作：{who}在等你审批或回答，处理完它才能接着做。
        </p>
        <div className="flex flex-wrap items-center gap-2 empty:hidden">
          <ApprovalActions
            onDecide={approval.decide}
            pending={approval.pending}
            task={task}
          />
        </div>
        {approval.error ? (
          <p className="m-0 text-(--wb-danger-fg) text-[13px]" role="alert">
            {approval.error instanceof RequestError &&
            /[\u4e00-\u9fff]/.test(approval.error.message)
              ? `没处理成：${approval.error.message}`
              : "没处理成，结果未确认，请刷新后核对。"}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {canExtend(task)
            ? extendButton(
                late !== null || asking ? "准许延期到……" : "改预计时间",
              )
            : null}
          {cancelButton}
        </div>
      </div>
    );
  else if (followed && status === "running")
    actions = (
      <div
        className={cn(
          "flex flex-col gap-2",
          stacked ? null : "sm:flex-row sm:flex-wrap",
        )}
      >
        {canNudge(task) ? (
          <button
            className={cn(deliveryButton(late !== null, size), wide)}
            disabled={writes.busy.has(task.id)}
            onClick={() => writes.run(task, "nudge")}
            type="button"
          >
            {late !== null ? "再催一次，让它先交做完的部分" : "催一下"}
          </button>
        ) : null}
        {canExtend(task)
          ? extendButton(
              late !== null || asking ? "准许延期到……" : "改预计时间",
            )
          : null}
        {canReassign(task) ? (
          <button
            className={cn(deliveryButton(false, size), wide)}
            onClick={() => setDialog({ kind: "reassign", card: task })}
            type="button"
          >
            换个员工接手
          </button>
        ) : null}
        {cancelButton}
      </div>
    );

  return (
    <div className="flex flex-col gap-[18px] p-6 max-sm:px-4">
      <header className="flex flex-col gap-1.5 pr-8">
        <span className="flex flex-wrap items-center gap-x-2 text-(--wb-muted) text-[12px]">
          <span>
            任务卡 · {who}
            {where ? ` · ${where.label}` : ""}
          </span>
          {where && task.open ? (
            <Link
              className="text-(--wb-fg2) underline-offset-2 hover:underline"
              params={{ channelId: task.open.id }}
              to={where.to}
            >
              到对话里看
            </Link>
          ) : null}
        </span>
        <SheetTitle className="m-0 font-semibold text-(--wb-fg) text-[18px] leading-[1.4] [overflow-wrap:anywhere]">
          {task.title}
        </SheetTitle>
        <ZoneNote now={now} />
      </header>

      {followed ? (
        <Progress finished={status === "done"} steps={steps} />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-(--wb-muted) text-[13px]">
            {canTrack(task)
              ? "这件活没在跟，不走三步收货。当作一件活来跟以后，它进「派出 · 待接下」，员工下一轮先回接活回执，到点没交服务器会催。"
              : "这件活没在跟，不走三步收货。"}
          </p>
          {canTrack(task) ? <TrackButton taskId={task.id} /> : null}
        </div>
      )}

      {status === "cancelled" ? (
        <p className="m-0 text-(--wb-muted) text-[13px]">
          这件活已取消（
          {clockText(lastOf(history, "cancelled") ?? task.updatedAt, now, zone)}
          ）。
        </p>
      ) : null}
      {late !== null ||
      formerly !== null ||
      task.lastError ||
      asking ||
      (task.returns ?? 0) > 0 ? (
        <div className="flex flex-col gap-1.5 text-[13px]">
          {late !== null ? (
            <span className="inline-flex items-center gap-[5px] self-start rounded-(--wb-radius-pill) bg-(--wb-danger-soft) px-2 py-[3px] text-(--wb-danger-fg) text-[12px]">
              {overdueChip(late, task.nudges ?? 0)}
            </span>
          ) : null}
          {formerly !== null ? (
            <span className="text-(--wb-muted)">
              曾逾期 {lengthText(formerly)}
              ，已给了更多时间或已交；逾期记录留在流水里。
            </span>
          ) : null}
          {asking ? (
            <span className="text-(--wb-amber-fg)">
              {who}申请延期
              {asking.dueAt ? `到 ${dueText(asking.dueAt, now, zone)}` : ""}
              ，等你答复。
            </span>
          ) : null}
          {task.lastError ? <LastError raw={task.lastError} /> : null}
          {(task.returns ?? 0) > 0 ? (
            <span className="text-(--wb-muted)">退回过 {task.returns} 次</span>
          ) : null}
        </div>
      ) : null}

      {late !== null ? (
        <section aria-label="逾期了，怎么办？" className="flex flex-col gap-3">
          <h3 className="m-0 font-semibold text-(--wb-fg) text-[16px]">
            逾期了，怎么办？
          </h3>
          <WatchSteps
            timeZone={zone}
            agentId={task.executorAgentId}
            events={events}
            history={history}
            nameOf={nameOf}
            now={now}
            title={task.title}
          />
          {stacked ? (
            <>
              <WriteFailure
                failure={writes.failure}
                onDismiss={writes.clearFailure}
              />
              {actions}
            </>
          ) : null}
          <p className="m-0 text-(--wb-muted) text-[12px] leading-[1.6]">
            逾期多久、催了几次都写进卡片流水，不会因为后来交了就抹掉。
          </p>
        </section>
      ) : null}

      <section aria-label="交付物与证据" className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>交付物与证据</h3>
        {evidence.length > 0 ? (
          evidence.map((row, index) => (
            <EvidenceLine
              agentId={task.executorAgentId}
              // biome-ignore lint/suspicious/noArrayIndexKey: 同一份交付物里的行，先后不会变。
              key={index}
              row={row}
              taskId={task.id}
            />
          ))
        ) : (
          <p className="m-0 text-(--wb-muted) text-[13px]">还没交成果。</p>
        )}
        <span className="text-(--wb-muted) text-[12px] leading-[1.6]">
          {task.criteria
            ? `验收标准（派活时写下的）：${task.criteria}`
            : "派活时没写验收标准。"}
        </span>
      </section>

      {stacked ? null : (
        <>
          <WriteFailure
            failure={writes.failure}
            onDismiss={writes.clearFailure}
          />
          {actions}
        </>
      )}

      <section
        aria-label="流水"
        className="flex flex-col gap-2.5 border-(--wb-line) border-t pt-4"
      >
        <h3 className={SECTION_TITLE}>
          流水{" "}
          <small className="font-normal text-(--wb-muted) text-[12px]">
            只追加，不改写
          </small>
        </h3>
        {events.isError ? (
          <p className="m-0 text-(--wb-danger-fg) text-[12.5px]" role="alert">
            读不到流水，稍后再试。
          </p>
        ) : lines.length === 0 ? (
          <p className="m-0 text-(--wb-muted) text-[12.5px]">
            {events.isPending ? "正在读流水…" : "还没有流水。"}
          </p>
        ) : (
          <ol className="m-0 grid list-none grid-cols-[max-content_minmax(0,1fr)] gap-x-2.5 gap-y-1 p-0 text-[12.5px] leading-[1.6]">
            {lines.map(({ event, line }) => (
              <li className="contents" key={event.id}>
                <time className="text-(--wb-muted)" dateTime={event.createdAt}>
                  {clockText(event.createdAt, now, zone)}
                </time>
                <span className="text-(--wb-fg2) [overflow-wrap:anywhere]">
                  {line.text}
                  {line.warn ? (
                    <b className="font-semibold text-(--wb-amber)">
                      {line.warn}
                    </b>
                  ) : null}
                  {line.rest ?? ""}
                  {line.technical ? (
                    <TechnicalError raw={line.technical} />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <DeliveryDialogs onClose={() => setDialog(null)} open={dialog} />
    </div>
  );
}
