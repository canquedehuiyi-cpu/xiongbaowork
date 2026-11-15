import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useScheduleZone, useZoneNote } from "@/lib/settings/work-hours";
import { taskAction } from "@/lib/tasks/actions";
import {
  cancelTask,
  clockText,
  type DeliveryVerb,
  deliveryErrorText,
  denyExtension,
  editCriteria,
  extendTask,
  nudgeTask,
  pendingExtension,
  plainErrorText,
  reassignTask,
  returnTask,
  taskEventsQueryOptions,
} from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import { useSkinId } from "@/skins/store";

/*
 * 在跟卡上的几个动作（交付闭环 Task 8）：验收、退回（写原因）、取消、催一下、准许延期、换人接手。看板的
 * 卡和卡片详情用同一套，接口见 `lib/tasks/delivery.ts`。颜色只从 `--wb-*` 令牌取（`skin.css`）。
 */

/*
 * 卡片详情和这些弹层也可能在别的皮肤里打开（手机推送、深链落到 `/tasks/<id>`），那里没有 `--wb-*`。
 * 这时在弹出层的根上把用到的令牌接到应用自己的令牌上，颜色不至于透明。默认皮肤里什么都不加。
 */
const WB_FALLBACK = {
  "--wb-bg": "var(--background)",
  "--wb-list": "var(--popover)",
  "--wb-card": "var(--card)",
  "--wb-card2": "var(--muted)",
  "--wb-hover": "var(--accent)",
  "--wb-fg": "var(--foreground)",
  "--wb-fg2": "var(--foreground)",
  "--wb-muted": "var(--muted-foreground)",
  "--wb-line": "var(--border)",
  "--wb-line2": "var(--border)",
  "--wb-blue": "var(--primary)",
  "--wb-blue-fg": "var(--primary-foreground)",
  "--wb-blue-line": "var(--primary)",
  "--wb-blue-soft": "color-mix(in oklab, var(--primary) 14%, transparent)",
  "--wb-blue-text": "var(--primary)",
  "--wb-danger-fg": "var(--destructive)",
  "--wb-danger-soft":
    "color-mix(in oklab, var(--destructive) 14%, transparent)",
  "--wb-danger-line": "var(--destructive)",
  "--wb-amber": "#d98a00",
  "--wb-amber-soft": "rgba(245, 165, 36, 0.15)",
  "--wb-amber-fg": "#b06f00",
  "--wb-green": "#2f9e6a",
  "--wb-green-fg": "#1f9d63",
  "--wb-main": "var(--background)",
  "--wb-ctx-track": "var(--muted)",
  "--wb-radius": "12px",
  "--wb-radius-pill": "99px",
} as CSSProperties;

/** 别的皮肤里给弹出层根元素的兜底令牌；默认皮肤为 undefined。 */
export function useWbFallback(): CSSProperties | undefined {
  return useSkinId() === "xiongbao" ? undefined : WB_FALLBACK;
}

/**
 * 作息时区和这台设备的钟不一样时，清点页、卡片详情顶上的一行小字：「时间按你的作息时区（中国标准时间）显示」。
 * 一样时什么都不画。
 */
export function ZoneNote({ now }: { now?: Date }) {
  const note = useZoneNote(now);
  if (!note) return null;
  return (
    <p className="m-0 text-(--wb-muted) text-[12px]" data-zone-note>
      {note}
    </p>
  );
}

/** 设计稿 1 的按钮：32px 高的灰按钮，`primary` 是验收那种蓝按钮。 */
export const deliveryButton = (
  primary = false,
  size: "sm" | "md" | "lg" = "sm",
) =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[8px] border px-3 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-(--wb-blue) disabled:cursor-default disabled:opacity-60",
    size === "sm"
      ? "h-8 text-[13px]"
      : size === "md"
        ? "h-9 px-[14px] text-[13px]"
        : "h-11 rounded-[10px] text-[14px]",
    primary
      ? "border-(--wb-blue) bg-(--wb-blue) font-semibold text-(--wb-blue-fg) hover:opacity-90"
      : "border-(--wb-line2) bg-(--wb-card2) text-(--wb-fg) hover:bg-(--wb-hover)",
  );

const FIELD =
  "w-full rounded-[10px] border border-(--wb-line2) bg-(--wb-card2) px-3 py-2 text-(--wb-fg) text-[14px] outline-none placeholder:text-(--wb-muted) focus-visible:border-(--wb-blue)";

/** 卡片上一个动作要知道的那张卡。 */
export type ActionCard = {
  id: string;
  title: string;
  executorAgentId: string | null;
};

/**
 * 不带输入的几个写：验收、取消、催一下。按卡记着哪张正在提交，失败时留下服务器自己的那句话。写成功后看板和
 * 详情一起重读（查询键都以 `tasks` 开头）。
 */
export function useDeliveryWrites() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const write = useMutation({
    mutationFn: (input: {
      card: ActionCard;
      verb: "review" | "cancel" | "nudge";
    }) =>
      input.verb === "review"
        ? taskAction({ id: input.card.id, verb: "review" })
        : input.verb === "cancel"
          ? cancelTask(input.card.id)
          : nudgeTask(input.card.id),
    // 写没收到回应时也可能已经落了地：不重放，只把话说出来。
    retry: false,
    onMutate: (input) => {
      setFailure(null);
      setBusy((current) => new Set([...current, input.card.id]));
    },
    onError: (error, input) =>
      setFailure({
        title: input.card.title,
        message: deliveryErrorText(error, input.verb),
      }),
    onSettled: (_data, _error, input) => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(input.card.id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks-briefing"] });
    },
  });
  return {
    busy,
    failure,
    clearFailure: () => setFailure(null),
    run: (card: ActionCard, verb: "review" | "cancel" | "nudge") => {
      if (busy.has(card.id)) return;
      write.mutate({ card, verb });
    },
  };
}

/**
 * 卡上「上一轮出错」那一行。原因像一句通俗中文就照写；不像（英文异常、网关报错）就只说「上一轮出错了」，
 * 原文折叠在「技术细节」里，要看的人点开看。
 */
export function LastError({
  raw,
  className,
}: {
  raw: string;
  className?: string;
}) {
  const plain = plainErrorText(raw);
  if (plain)
    return (
      <p
        className={cn(
          "m-0 text-(--wb-danger-fg) leading-[1.5] [overflow-wrap:anywhere]",
          className,
        )}
      >
        上一轮出错：{plain}
      </p>
    );
  return <TechnicalError className={className} raw={raw} said="上一轮出错了" />;
}

/** 一句人话，后面折叠着原文。 */
export function TechnicalError({
  said,
  raw,
  className,
}: {
  /** 折叠前的那句人话；流水里那一行已经说了「这一轮出错了」，就不再说。 */
  said?: ReactNode;
  raw: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 leading-[1.5]", className)}>
      {said ? <span className="text-(--wb-danger-fg)">{said}</span> : null}
      <details className="text-(--wb-muted)">
        <summary className="cursor-pointer outline-none hover:text-(--wb-fg2) focus-visible:text-(--wb-fg)">
          技术细节
        </summary>
        <code className="mt-1 block whitespace-pre-wrap break-all font-mono text-[11.5px]">
          {raw}
        </code>
      </details>
    </div>
  );
}

/** 写失败时卡片上方的一行：哪件活、服务器怎么说。 */
export function WriteFailure({
  failure,
  onDismiss,
}: {
  failure: { title: string; message: string } | null;
  onDismiss: () => void;
}) {
  if (!failure) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-(--wb-radius) border border-(--wb-danger-line) bg-(--wb-danger-soft) px-4 py-2.5 text-(--wb-fg) text-[13px]"
      role="alert"
    >
      <span>
        「{failure.title}」没处理成：{failure.message}
      </span>
      <button
        className={cn(deliveryButton(), "ml-auto h-7")}
        onClick={onDismiss}
        type="button"
      >
        知道了
      </button>
    </div>
  );
}

/** 三个弹层共用的外框。 */
function ActionDialog({
  title,
  description,
  children,
  onClose,
  busy,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const fallback = useWbFallback();
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      open
    >
      <DialogContent
        className="max-w-[460px] gap-3 rounded-[16px] border-(--wb-line2) bg-(--wb-card) p-[22px] text-(--wb-fg)"
        showCloseButton={false}
        style={fallback}
      >
        <DialogTitle className="m-0 font-semibold text-(--wb-fg) text-[17px]">
          {title}
        </DialogTitle>
        <DialogDescription className="m-0 text-(--wb-fg2) text-[13.5px] leading-[1.7]">
          {description}
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function DialogFailure({
  error,
  verb,
}: {
  error: unknown;
  verb: DeliveryVerb;
}) {
  if (!error) return null;
  return (
    <p className="m-0 text-(--wb-danger-fg) text-[13px]" role="alert">
      {deliveryErrorText(error, verb)}
    </p>
  );
}

function DialogButtons({
  onClose,
  busy,
  disabled,
  submit,
  busyLabel,
}: {
  onClose: () => void;
  busy: boolean;
  disabled: boolean;
  submit: string;
  busyLabel: string;
}) {
  return (
    <div className="flex justify-end gap-2.5">
      <button
        className={deliveryButton(false, "md")}
        disabled={busy}
        onClick={onClose}
        type="button"
      >
        先不
      </button>
      <button
        className={deliveryButton(true, "md")}
        disabled={disabled || busy}
        type="submit"
      >
        {busy ? busyLabel : submit}
      </button>
    </div>
  );
}

const useSettled = () => {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["tasks-summary"] });
    void queryClient.invalidateQueries({ queryKey: ["tasks-briefing"] });
  };
};

/**
 * 退回（规格第 6 节）：原因必填，服务器以你的名义把它发进这件活的对话，员工接着做。只写空格不算原因，
 * 提交按钮一直灰着。
 */
export function ReturnDialog({
  card,
  onClose,
}: {
  card: ActionCard;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const settled = useSettled();
  const send = useMutation({
    mutationFn: (text: string) => returnTask(card.id, text),
    retry: false,
    onSuccess: () => onClose(),
    onSettled: settled,
  });
  const text = reason.trim();
  return (
    <ActionDialog
      busy={send.isPending}
      description="写清楚哪里不对、要它怎么改。原因会以你的名义发进这件活的对话，员工接着改，改完再交给你验收。"
      onClose={onClose}
      title={`退回「${card.title}」`}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text && !send.isPending) send.mutate(text);
        }}
      >
        <textarea
          aria-label="退回原因"
          className={cn(FIELD, "min-h-[96px] resize-y leading-[1.6]")}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：缺了 C 家的电话，补上再交"
          value={reason}
        />
        <span className="text-(--wb-muted) text-[12px]">
          {text ? `${text.length} / 500` : "退回要写原因，写了才能提交。"}
        </span>
        <DialogFailure error={send.error} verb="return" />
        <DialogButtons
          busy={send.isPending}
          busyLabel="正在退回…"
          disabled={!text}
          onClose={onClose}
          submit="退回给员工"
        />
      </form>
    </ActionDialog>
  );
}

/**
 * 准许延期到……：员工申请过、还没答复，就答复那条申请（默认填它要的时间）；没申请过就是你直接改预计时间。
 * 时间照你平时说的写（「16:00」「40 分钟」「明天上午十点」），服务器按你的时区认。
 */
export function ExtendDialog({
  card,
  onClose,
  now = new Date(),
  mode = "extend",
}: {
  card: ActionCard;
  onClose: () => void;
  now?: Date;
  /**
   * `edit` 是对话里接活回执上的「改预计时间」：标题、输入框和按钮都按「改预计时间」说；员工有待答复的
   * 延期申请时，在说明里讲明这次填的时间会作为对那条申请的答复。
   */
  mode?: "extend" | "edit";
}) {
  const editing = mode === "edit";
  const events = useQuery(taskEventsQueryOptions(card.id));
  const pending = events.data ? pendingExtension(events.data) : null;
  // 员工要的时间按作息时区写进输入框：提交的「16:00」服务器也按作息时区认。
  const zone = useScheduleZone();
  const requested = pending?.dueAt ? clockText(pending.dueAt, now, zone) : "";
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed ?? requested;
  const settled = useSettled();
  const send = useMutation({
    mutationFn: (dueAt: string) => extendTask(card.id, dueAt, pending !== null),
    retry: false,
    onSuccess: () => onClose(),
    onSettled: settled,
  });
  const deny = useMutation({
    mutationFn: () => denyExtension(card.id),
    retry: false,
    onSuccess: () => onClose(),
    onSettled: settled,
  });
  const busy = send.isPending || deny.isPending;
  /*
   * 读不到流水就不知道员工有没有待答复的延期申请：这时提交会绕过那条申请直接改时间，申请一直悬着。
   * 所以读失败时不让提交，请人稍后再试。
   */
  const unknown = events.isError;
  return (
    <ActionDialog
      busy={busy}
      description={
        pending
          ? editing
            ? `员工有一条待答复的延期申请${requested ? `（要延到 ${requested}）` : ""}。这里填的时间会作为对它的答复：按你填的时间准许。也可以不批。`
            : `员工申请延期${requested ? `到 ${requested}` : ""}。可以照准，也可以改一个时间，或者不批。`
          : "给员工一个新的预计时间，到点还没交，服务器照常催、照常记逾期。"
      }
      onClose={onClose}
      title={
        editing
          ? `改「${card.title}」的预计时间`
          : `准许「${card.title}」延期到……`
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const dueAt = value.trim();
          if (dueAt && !busy && !unknown && !events.isPending)
            send.mutate(dueAt);
        }}
      >
        <input
          aria-label={editing ? "改到几点" : "延到几点"}
          className={cn(FIELD, "h-10")}
          maxLength={100}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="例如 16:00、40 分钟、明天上午十点"
          value={value}
        />
        {unknown ? (
          <p className="m-0 text-(--wb-danger-fg) text-[13px]" role="alert">
            读不到这件活的延期申请，先别改，稍后再试。
          </p>
        ) : null}
        <DialogFailure error={send.error} verb="extend" />
        <DialogFailure error={deny.error} verb="deny" />
        {pending ? (
          <button
            className={cn(deliveryButton(false, "md"), "self-start")}
            disabled={busy}
            onClick={() => deny.mutate()}
            type="button"
          >
            {deny.isPending ? "正在答复…" : "不批，按原时间交"}
          </button>
        ) : null}
        <DialogButtons
          busy={busy}
          busyLabel="正在改…"
          disabled={!value.trim() || events.isPending || unknown}
          onClose={onClose}
          submit={
            editing ? (pending ? "按这个时间准许" : "改预计时间") : "准许延期"
          }
        />
      </form>
    </ActionDialog>
  );
}

/**
 * 改验收标准（对话里接活回执上的「改验收标准」）：你改的直接生效，员工交付时按新的核对，里面写的
 * 「必需：A、B、C」照样逐项核对。交了成果以后改不了，退回后可以再改。
 */
export function CriteriaDialog({
  card,
  current,
  onClose,
}: {
  card: ActionCard;
  /** 此刻的验收标准，预先填好。 */
  current: string | null;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState(current ?? "");
  const settled = useSettled();
  const send = useMutation({
    mutationFn: (criteria: string) => editCriteria(card.id, criteria),
    retry: false,
    onSuccess: () => onClose(),
    onSettled: settled,
  });
  const text = typed.trim();
  return (
    <ActionDialog
      busy={send.isPending}
      description="改了直接生效，员工交付时按新的标准核对。要求必须交的项，可以在末尾写「必需：A、B、C」。"
      onClose={onClose}
      title={`改「${card.title}」的验收标准`}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text && text !== (current ?? "").trim() && !send.isPending)
            send.mutate(text);
        }}
      >
        <textarea
          aria-label="验收标准"
          className={cn(FIELD, "min-h-[96px] resize-y leading-[1.6]")}
          maxLength={1000}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="例如：三家全部在售款，带本周和上周价格。必需：A 家、B 家、C 家"
          value={typed}
        />
        <DialogFailure error={send.error} verb="criteria" />
        <DialogButtons
          busy={send.isPending}
          busyLabel="正在改…"
          disabled={!text || text === (current ?? "").trim()}
          onClose={onClose}
          submit="改验收标准"
        />
      </form>
    </ActionDialog>
  );
}

/** 换个员工接手（规格第 8 节）：新员工要重新接下，卡回到「派出 · 待接下」。 */
export function ReassignDialog({
  card,
  onClose,
}: {
  card: ActionCard;
  onClose: () => void;
}) {
  const coworkers = useQuery(agentListQueryOptions());
  const choices = (coworkers.data ?? []).filter(
    (coworker) => coworker.id !== card.executorAgentId,
  );
  const [agentId, setAgentId] = useState("");
  const settled = useSettled();
  const send = useMutation({
    mutationFn: (to: string) => reassignTask(card.id, to),
    retry: false,
    onSuccess: () => onClose(),
    onSettled: settled,
  });
  return (
    <ActionDialog
      busy={send.isPending}
      description="原来那位员工这一轮会停下。新员工拿到标题、验收标准、已有的交付物和最后的进度，要重新接下，自己报预计时间。"
      onClose={onClose}
      title={`换个员工接手「${card.title}」`}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (agentId && !send.isPending) send.mutate(agentId);
        }}
      >
        <select
          aria-label="换给谁"
          className={cn(FIELD, "h-10")}
          onChange={(event) => setAgentId(event.target.value)}
          value={agentId}
        >
          <option value="">选一位员工</option>
          {choices.map((coworker) => (
            <option key={coworker.id} value={coworker.id}>
              {coworker.name}
            </option>
          ))}
        </select>
        <DialogFailure error={send.error} verb="reassign" />
        <DialogButtons
          busy={send.isPending}
          busyLabel="正在换…"
          disabled={!agentId}
          onClose={onClose}
          submit="换人接手"
        />
      </form>
    </ActionDialog>
  );
}

/** 哪张卡开着哪个弹层。 */
export type OpenDialog =
  | { kind: "return"; card: ActionCard }
  | { kind: "extend"; card: ActionCard }
  | { kind: "reassign"; card: ActionCard }
  | null;

export function DeliveryDialogs({
  open,
  onClose,
}: {
  open: OpenDialog;
  onClose: () => void;
}) {
  if (!open) return null;
  if (open.kind === "return")
    return <ReturnDialog card={open.card} onClose={onClose} />;
  if (open.kind === "extend")
    return <ExtendDialog card={open.card} onClose={onClose} />;
  return <ReassignDialog card={open.card} onClose={onClose} />;
}
