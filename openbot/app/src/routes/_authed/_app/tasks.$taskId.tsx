import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  clockText,
  deliveryLaneOf,
  type EvidenceRow,
  eventLine,
  eventsInOrder,
  evidenceOf,
  type FollowedCard,
  followedCardQueryOptions,
  overdueChip,
  overdueMinutes,
  pendingExtension,
  type TaskEvent,
  taskEventsQueryOptions,
  withCoworker,
} from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import {
  DeliveryDialogs,
  deliveryButton,
  type OpenDialog,
  useDeliveryWrites,
  WriteFailure,
} from "@/skins/xiongbao/delivery-actions";

/**
 * 任务卡详情（交付闭环 Task 8，设计稿 2）：四步进度、交付物与证据、验收标准、验收 / 退回（写原因）/ 取消、
 * 流水（按时间正序，只追加）。员工手上的卡还有「再催一次」「准许延期到……」「换个员工接手」（设计稿 5）。
 *
 * 在看板上面从右边滑出来（手机上占满一屏），关上回到看板，看板的筛选不变。深链和手机推送也落到这里。
 * 颜色只从 `--wb-*` 令牌取（`skin.css`）。
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
  diff: "改动汇总",
  note: "文字结论",
  check: "员工自查",
};

function EvidenceLine({ row }: { row: EvidenceRow }) {
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
      <span className="ml-auto shrink-0 text-(--wb-muted) text-[12px]">
        {row.kind === "diff"
          ? `${row.detail} · ${ROW_NOTE.diff}`
          : ROW_NOTE[row.kind]}
      </span>
    </div>
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
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

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
    });
    return line ? [{ event, line }] : [];
  });
  const followed = deliveryLaneOf(task) !== null;
  const late = overdueMinutes(task, now);
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
      ),
      reached: true,
    },
    {
      label: "已接下",
      sub: task.dueAt
        ? `预计 ${clockText(task.dueAt, now)}`
        : task.acceptedAt
          ? `${clockText(task.acceptedAt, now)} 接下`
          : "—",
      reached: Boolean(task.acceptedAt) || handedIn,
    },
    {
      label: "已交成果",
      sub: handedIn
        ? clockText(lastOf(history, "delivered") ?? task.updatedAt, now)
        : "—",
      reached: handedIn,
    },
    {
      label: "你验收",
      sub:
        status === "done"
          ? clockText(lastOf(history, "reviewed") ?? task.updatedAt, now)
          : "—",
      reached: status === "done",
    },
  ];
  const where =
    task.open?.kind === "group"
      ? { to: "/group/$channelId" as const, label: "来自群聊" }
      : task.open?.kind === "channel"
        ? { to: "/channel/$channelId" as const, label: "来自单聊" }
        : null;

  const cancelButton = (
    <button
      className={cn(deliveryButton(false, "md"), "max-sm:w-full sm:ml-auto")}
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
    actions = (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-(--wb-amber-fg) text-[13px]">
          等你操作：{who}在等你审批或回答，到对话里处理完它才能接着做。
        </p>
        <div className="flex flex-wrap gap-2">{cancelButton}</div>
      </div>
    );
  else if (followed && withCoworker(status))
    actions = (
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button
          className={cn(deliveryButton(late !== null, "md"), "max-sm:w-full")}
          disabled={writes.busy.has(task.id)}
          onClick={() => writes.run(task, "nudge")}
          type="button"
        >
          {late !== null ? "再催一次，让它先交做完的部分" : "催一下"}
        </button>
        {task.acceptedAt ? (
          <button
            className={cn(deliveryButton(false, "md"), "max-sm:w-full")}
            onClick={() => setDialog({ kind: "extend", card: task })}
            type="button"
          >
            {late !== null || asking ? "准许延期到……" : "改预计时间"}
          </button>
        ) : null}
        <button
          className={cn(deliveryButton(false, "md"), "max-sm:w-full")}
          onClick={() => setDialog({ kind: "reassign", card: task })}
          type="button"
        >
          换个员工接手
        </button>
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
      </header>

      {followed ? (
        <Progress finished={status === "done"} steps={steps} />
      ) : (
        <p className="m-0 text-(--wb-muted) text-[13px]">
          这件活没在跟，不走三步收货。
        </p>
      )}

      {status === "cancelled" ? (
        <p className="m-0 text-(--wb-muted) text-[13px]">
          这件活已取消（
          {clockText(lastOf(history, "cancelled") ?? task.updatedAt, now)}）。
        </p>
      ) : null}
      {late !== null || task.lastError || asking || (task.returns ?? 0) > 0 ? (
        <div className="flex flex-col gap-1.5 text-[13px]">
          {late !== null ? (
            <span className="inline-flex items-center gap-[5px] self-start rounded-(--wb-radius-pill) bg-(--wb-danger-soft) px-2 py-[3px] text-(--wb-danger-fg) text-[12px]">
              {overdueChip(late, task.nudges ?? 0)}
            </span>
          ) : null}
          {asking ? (
            <span className="text-(--wb-amber-fg)">
              {who}申请延期
              {asking.dueAt ? `到 ${clockText(asking.dueAt, now)}` : ""}
              ，等你答复。
            </span>
          ) : null}
          {task.lastError ? (
            <span className="text-(--wb-danger-fg) [overflow-wrap:anywhere]">
              上一轮出错：{task.lastError}
            </span>
          ) : null}
          {(task.returns ?? 0) > 0 ? (
            <span className="text-(--wb-muted)">退回过 {task.returns} 次</span>
          ) : null}
        </div>
      ) : null}

      <section aria-label="交付物与证据" className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>交付物与证据</h3>
        {evidence.length > 0 ? (
          evidence.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同一份交付物里的行，先后不会变。
            <EvidenceLine key={index} row={row} />
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

      <WriteFailure failure={writes.failure} onDismiss={writes.clearFailure} />
      {actions}

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
                  {clockText(event.createdAt, now)}
                </time>
                <span className="text-(--wb-fg2) [overflow-wrap:anywhere]">
                  {line.text}
                  {line.warn ? (
                    <b className="font-semibold text-(--wb-amber)">
                      {line.warn}
                    </b>
                  ) : null}
                  {line.rest ?? ""}
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
