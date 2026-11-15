import { useState } from "react";
import type {
  AcpCard,
  AcpDiffFile,
  AcpPlanEntry,
} from "@/lib/channels/acp-events";
import { cn } from "@/lib/utils";

/*
 * 外部员工在对话里的四张卡（外部员工 Task 12，设计稿第 3 屏）：进度卡（`acp.plan`）、改动卡（`acp.diff`）、
 * 中断卡（`acp.interrupted`）和请求许可卡（它的「等你确认」）。
 *
 * 默认皮肤和别的皮肤都画：颜色先取 `--wb-*` 令牌，没有时取应用自己的主题令牌，不会露出透明底。
 */

/** 卡片外框：工作台的卡片底和细线，别的皮肤用应用的 card / border。 */
export const ACP_CARD =
  "flex w-full max-w-[620px] flex-col gap-2.5 self-start rounded-[var(--wb-radius-bubble,14px)] border border-[color:var(--wb-line,var(--border))] bg-[color:var(--wb-card,var(--card))] px-[18px] py-4 text-[14px] text-[color:var(--wb-fg,var(--foreground))]";

const SECONDARY_TEXT = "text-[color:var(--wb-fg2,var(--muted-foreground))]";
const MUTED_TEXT = "text-[color:var(--wb-muted,var(--muted-foreground))]";
const MONO_BLOCK =
  "m-0 whitespace-pre-wrap break-all rounded-[var(--wb-radius-sm,9px)] bg-[color:var(--wb-rail,var(--muted))] px-3 py-2.5 font-mono text-[13px] leading-relaxed";

/** 主按钮（批准）：工作台的红橙渐变，别的皮肤用应用的主色。 */
export const ACP_PRIMARY_BUTTON =
  "cursor-pointer rounded-[10px] border-0 [background:var(--wb-me,var(--primary))] px-[18px] py-2.5 font-semibold text-[color:var(--wb-me-fg,var(--primary-foreground))] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--wb-accent,var(--ring))] disabled:cursor-not-allowed disabled:opacity-60";
/** 次按钮（拒绝）。 */
export const ACP_SECONDARY_BUTTON =
  "cursor-pointer rounded-[10px] border border-[color:var(--wb-line2,var(--border))] bg-[color:var(--wb-card2,var(--secondary))] px-[18px] py-2.5 text-[color:var(--wb-fg,var(--foreground))] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--wb-accent,var(--ring))] disabled:cursor-not-allowed disabled:opacity-60";
/** 第三个按钮（这次对话里都允许）：透明底。 */
export const ACP_GHOST_BUTTON =
  "cursor-pointer rounded-[10px] border border-[color:var(--wb-line2,var(--border))] bg-transparent px-[18px] py-2.5 text-[color:var(--wb-fg2,var(--muted-foreground))] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--wb-accent,var(--ring))] disabled:cursor-not-allowed disabled:opacity-60";

const sign = (added: number, removed: number) => (
  <span className="whitespace-nowrap tabular-nums">
    {added > 0 || removed === 0 ? (
      <span className="text-[color:var(--wb-green,var(--color-emerald-500))]">
        +{added}
      </span>
    ) : null}
    {removed > 0 ? (
      <span className="ml-1 text-[color:var(--wb-accent2,var(--signal))]">
        −{removed}
      </span>
    ) : null}
  </span>
);

const STEP_MARK: Record<
  AcpPlanEntry["status"],
  { mark: string; label: string; className: string }
> = {
  completed: {
    mark: "✓",
    label: "已完成",
    className: "text-[color:var(--wb-green,var(--color-emerald-500))]",
  },
  in_progress: {
    mark: "●",
    label: "进行中",
    className: "text-[color:var(--wb-amber,var(--color-amber-500))]",
  },
  pending: {
    mark: "○",
    label: "还没开始",
    className: MUTED_TEXT,
  },
};

/** 进度卡：每一步一行，做完的打勾，正在做的一个圆点，还没开始的空心圈。 */
export function AcpPlanCard({ entries }: { entries: readonly AcpPlanEntry[] }) {
  if (entries.length === 0) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  const finished = done === entries.length;
  return (
    <section
      aria-label={finished ? "做完了" : "正在做"}
      className={ACP_CARD}
      data-acp-card="plan"
    >
      <div className="flex items-center gap-2">
        <b className="font-semibold">{finished ? "做完了" : "正在做"}</b>
        <span className={cn("text-[12px]", MUTED_TEXT)}>
          {done} / {entries.length} 步
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {entries.map((entry, index) => {
          const step = STEP_MARK[entry.status];
          return (
            <li
              className={cn(
                "flex gap-2.5 leading-relaxed",
                entry.status === "in_progress"
                  ? "text-[color:var(--wb-fg,var(--foreground))]"
                  : SECONDARY_TEXT,
              )}
              data-step={entry.status}
              // 计划每次整份重发，条目没有自己的 id；同一位置就是同一步。
              // biome-ignore lint/suspicious/noArrayIndexKey: 见上
              key={index}
            >
              <span
                aria-hidden="true"
                className={cn("shrink-0", step.className)}
              >
                {step.mark}
              </span>
              <span className="sr-only">{step.label}：</span>
              <span className="min-w-0">{entry.content}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 改动卡：改了几个文件、一共加减几行；「看改动」展开每个文件各自的行数。 */
export function AcpDiffCard({ files }: { files: readonly AcpDiffFile[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <section aria-label="改动" className={ACP_CARD} data-acp-card="diff">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span>改了 {files.length} 个文件</span>
        {sign(added, removed)}
        <button
          aria-expanded={open}
          className="cursor-pointer border-0 bg-transparent p-0 text-[color:var(--wb-accent2,var(--primary))] underline-offset-2 outline-none hover:text-[color:var(--wb-accent,var(--primary))] hover:underline focus-visible:underline"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? "收起" : "看改动"}
        </button>
      </div>
      {open ? (
        <ul
          aria-label="改动的文件"
          className="m-0 flex list-none flex-col overflow-hidden rounded-[var(--wb-radius,12px)] border border-[color:var(--wb-line,var(--border))] p-0"
        >
          {files.map((file) => (
            <li
              className="flex items-center justify-between gap-3 border-[color:var(--wb-line,var(--border))] border-b px-3 py-2.5 last:border-b-0"
              key={file.path}
            >
              <span className="min-w-0 break-all font-mono text-[13px]">
                {file.path}
              </span>
              {sign(file.added, file.removed)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * 中断卡（规格第 3 节）：电脑关机，这一轮没做完；「重新派」把原话作为新的一轮再发一次。「电脑关机，这件活中断了。」
 * 服务器已经在对话里说过（`agent.ts` 的 note），卡上不再重复，只给一句补充和按钮。没有原话、或没有地方发时
 * 卡片什么都不画，那句话就够了。
 */
export function AcpInterruptedCard({
  prompt,
  resent,
  onResend,
}: {
  prompt: string;
  /** 这张卡已经重新派过了。 */
  resent?: boolean;
  /** 不给时（没有可发的地方）不画这张卡。 */
  onResend?: () => unknown;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">(
    resent ? "sent" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const canResend = prompt !== "" && onResend !== undefined;
  if (!canResend) return null;
  return (
    <section
      aria-label="这件活中断了"
      className={cn(
        ACP_CARD,
        "border-[color:color-mix(in_oklab,var(--wb-amber,var(--signal))_45%,transparent)]",
      )}
      data-acp-card="interrupted"
    >
      <span className="text-[color:var(--wb-fg2,var(--muted-foreground))]">
        电脑开机后可以重新派。
      </span>
      {canResend ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            className={ACP_PRIMARY_BUTTON}
            disabled={state !== "idle" || resent}
            onClick={async () => {
              setState("sending");
              setError(null);
              try {
                await onResend?.();
                setState("sent");
              } catch (failure) {
                setState("idle");
                setError(
                  failure instanceof Error && failure.message
                    ? failure.message
                    : "没能重新派出去，再试一次。",
                );
              }
            }}
            type="button"
          >
            {state === "sent" || resent
              ? "已重新派"
              : state === "sending"
                ? "正在派…"
                : "重新派"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p
          className="m-0 text-[13px] text-[color:var(--wb-amber-fg,var(--signal-ink))]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** 对话里的一张进度、改动或中断卡。 */
export function AcpCardView({
  card,
  resent,
  onResend,
}: {
  card: AcpCard;
  resent?: boolean;
  onResend?: (card: Extract<AcpCard, { kind: "interrupted" }>) => unknown;
}) {
  if (card.kind === "plan") return <AcpPlanCard entries={card.entries} />;
  if (card.kind === "diff") return <AcpDiffCard files={card.files} />;
  // 之后又开始过别的轮次：不再给「重新派」。
  if (card.superseded)
    return (
      <section
        aria-label="这件活中断了"
        className={cn(ACP_CARD, "py-3")}
        data-acp-card="interrupted"
        data-superseded=""
      >
        <span className={MUTED_TEXT}>
          {resent ? "已重新派。" : "这件活已有后续。"}
        </span>
      </section>
    );
  return (
    <AcpInterruptedCard
      onResend={onResend ? () => onResend(card) : undefined}
      prompt={card.prompt}
      resent={resent}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// 请求许可卡
// ---------------------------------------------------------------------------------------------

/**
 * 外部员工的审批记录上带的卡片数据（服务器 `agents/acp/permissions.ts` 的 `AcpApprovalCard`，在审批的
 * `target.acp` 里）。只取画卡要用的几样。
 */
export type AcpApprovalCard = {
  employee: string;
  computer: string;
  /** 一句话：「代码熊想要运行命令：git push」。 */
  action: string;
  /** 命中的规则或底线。 */
  hit: string;
  reason: string;
  /** 这一轮做到哪了。 */
  summary: string;
  /** 这一轮改过的文件。 */
  files: string[];
  /** 底线和管理员拒绝的不给「这次对话里都允许」。 */
  offerConversation: boolean;
  /** 它说的那个工具调用，对话里的 id（`<runId>:<智能体的 id>`）。 */
  toolCallId?: string;
};

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** 一条审批是不是外部员工的；是的话取出它的卡片数据。 */
export function acpCardOf(action: {
  toolRef: string;
  target: unknown;
}): AcpApprovalCard | null {
  if (!action.toolRef.startsWith("acp/")) return null;
  const card = record(record(action.target)?.acp);
  if (!card) return null;
  return {
    employee: text(card.employee),
    computer: text(card.computer),
    action: text(card.action),
    hit: text(card.hit),
    reason: text(card.reason),
    summary: text(card.summary),
    files: Array.isArray(card.files)
      ? card.files.filter((file): file is string => typeof file === "string")
      : [],
    // 只有明说给的才给：读不懂时按不给算，宁可少一个按钮。
    offerConversation: card.offerConversation === true,
    ...(typeof card.toolCallId === "string" && card.toolCallId
      ? { toolCallId: card.toolCallId }
      : {}),
  };
}

/** 审批里命令或路径的原文：命令、网址、路径（一行一个），都没有时是它自己的标题。 */
export function acpRawText(args: unknown): string | null {
  const body = record(args);
  if (!body) return null;
  if (typeof body.command === "string" && body.command) return body.command;
  if (typeof body.url === "string" && body.url) return body.url;
  if (Array.isArray(body.paths)) {
    const paths = body.paths.filter(
      (path): path is string => typeof path === "string" && path !== "",
    );
    if (paths.length > 0) return paths.join("\n");
  }
  if (typeof body.title === "string" && body.title) return body.title;
  return null;
}

/**
 * 决定没能保存时卡上说的话。别处（手机、另一个窗口、规则撤回）已经决定过的，服务器回一句英文「This request
 * was already decided.」，这里说成中文；别的照服务器原话。
 */
export function decisionErrorText(error: unknown): string | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error as { status?: unknown }).status === 409 ||
    /already decided/i.test(message)
  )
    return "这条请求已经处理过了。";
  return message || "你的决定没能保存。";
}

/** 熊宝的三个选项，按钮上的字；对应 ACP 的 allow_once / allow_always / reject_once。 */
export const ACP_CHOICES = {
  allow_once: "批准",
  deny: "拒绝",
  allow_conversation: "这次对话里都允许",
} as const;
export type AcpChoice = keyof typeof ACP_CHOICES;

const ANSWERED_WORDS: Record<AcpChoice, string> = {
  allow_once: "已批准，只这一次。",
  deny: "已拒绝。",
  allow_conversation: "已允许，这次对话里同样的事不再问你。",
};

/** 卡上要几个按钮：底线和管理员拒绝的（`offerConversation === false`）只有批准和拒绝。 */
export function acpChoicesFor(
  card: Pick<AcpApprovalCard, "offerConversation">,
) {
  return (card.offerConversation
    ? ["allow_once", "deny", "allow_conversation"]
    : ["allow_once", "deny"]) satisfies AcpChoice[] as AcpChoice[];
}

/**
 * 请求许可卡（设计稿第 3 屏）：谁请求许可、命中了哪条规则，命令或路径的原文，说明，三个按钮（底线只有两个），
 * 底下一行说手机上也会收到。只画给招它的人：群里其他成员看到的是不带内容的状态行（`acp-group-line.tsx`）。
 *
 * 手机那一句不说死：前端分不出这个人有没有可用的手机推送（这个部署只有浏览器通知，没有已登记的手机通道），
 * 所以写「也会推到你的手机（如果开了通知）」。
 */
export const ACP_PHONE_NOTE = "也会推到你的手机（如果开了通知）";

export function AcpPermissionCard({
  card,
  raw,
  answered,
  submitting = false,
  error,
  onDecide,
}: {
  card: AcpApprovalCard;
  /** 命令或路径的原文（`acpRawText`）。 */
  raw: string | null;
  answered?: AcpChoice | null;
  submitting?: boolean;
  error?: string | null;
  onDecide?: (choice: AcpChoice) => void;
}) {
  const who = card.employee || "这位外部员工";
  return (
    <section
      aria-label="请求许可"
      className={cn(
        ACP_CARD,
        "gap-3 border-[color:color-mix(in_oklab,var(--wb-amber,var(--signal))_45%,transparent)]",
      )}
      data-acp-card="permission"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="font-semibold text-[color:var(--wb-gold,var(--signal-ink))]">
          {who}请求许可
        </b>
        {card.hit ? (
          <span className={cn("text-[12px]", MUTED_TEXT)}>{card.hit}</span>
        ) : null}
      </div>
      {raw ? <pre className={MONO_BLOCK}>{raw}</pre> : null}
      <span className={cn("leading-relaxed", SECONDARY_TEXT)}>
        {raw ? card.reason || card.action : card.action || card.reason}
      </span>
      {answered ? (
        <p className="m-0 text-[13px]" role="status">
          {ANSWERED_WORDS[answered]}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2.5">
            {acpChoicesFor(card).map((choice) => (
              <button
                className={
                  choice === "allow_once"
                    ? ACP_PRIMARY_BUTTON
                    : choice === "deny"
                      ? ACP_SECONDARY_BUTTON
                      : ACP_GHOST_BUTTON
                }
                disabled={submitting}
                key={choice}
                onClick={() => onDecide?.(choice)}
                type="button"
              >
                {ACP_CHOICES[choice]}
              </button>
            ))}
          </div>
          {error ? (
            <p
              className="m-0 text-[13px] text-[color:var(--wb-amber-fg,var(--signal-ink))]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <span className={cn("text-[12px]", MUTED_TEXT)}>
            {ACP_PHONE_NOTE}
          </span>
        </>
      )}
    </section>
  );
}
