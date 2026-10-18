import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

/**
 * Human-in-the-loop gallery components. `respond` resolves the suspended Bot run, and completed
 * cards render the recorded answer rather than active controls.
 */

/** What the render props carry. Narrowed here so each component reads as its own small contract. */
type Waiting<T> =
  | {
      status: "inProgress";
      args: Partial<T>;
      respond: undefined;
      result: undefined;
    }
  | {
      status: "executing";
      args: T;
      respond: (result: unknown) => Promise<void>;
      result: undefined;
    }
  | { status: "complete"; args: T; respond: undefined; result: string };

export const ApprovalCardProps = z.object({
  title: z.string().describe("What is being approved, in a few words"),
  summary: z
    .string()
    .describe("What the person is agreeing to, in one or two sentences"),
  details: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe(
      "The facts they need in order to decide, e.g. amount, vendor, date",
    ),
  approveLabel: z.string().optional().describe("Defaults to Approve"),
  rejectLabel: z.string().optional().describe("Defaults to Decline"),
});

type ApprovalArgs = z.infer<typeof ApprovalCardProps>;

export function ApprovalCard(props: Waiting<ApprovalArgs> & { name?: string }) {
  const { args, status, respond } = props;
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approved" | "declined" | null>(null);

  const answer = async (decision: "approved" | "declined") => {
    if (!respond) return;
    setSending(decision);
    // Include the note in the same tool result that resumes the Bot.
    await respond({ decision, note: note.trim() || undefined });
  };

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "正在等待员工…"}>
        <p className="text-sm text-muted-foreground">正在准备请求…</p>
      </GalleryFrame>
    );
  }

  const decided =
    status === "complete" ? readDecision(props.result) : undefined;

  return (
    <GalleryFrame
      action={
        decided ? (
          <Badge tone={decided === "approved" ? "positive" : "negative"}>
            {decided === "approved" ? "已批准" : "已拒绝"}
          </Badge>
        ) : (
          <Badge tone="caution">等你决定</Badge>
        )
      }
      title={args.title}
    >
      <p className="text-sm">{args.summary}</p>

      {args.details?.length ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {args.details.map((detail) => (
            <div className="contents" key={detail.label}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {decided ? null : (
        <div className="mt-4 space-y-2">
          <input
            aria-label="理由（可选）"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
            disabled={Boolean(sending)}
            onChange={(event) => setNote(event.target.value)}
            placeholder="理由（可选）"
            value={note}
          />
          <div className="flex gap-2">
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("approved")}
              size="sm"
            >
              {sending === "approved"
                ? "正在发送…"
                : (args.approveLabel ?? "批准")}
            </Button>
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("declined")}
              size="sm"
              variant="outline"
            >
              {sending === "declined"
                ? "正在发送…"
                : (args.rejectLabel ?? "拒绝")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
  );
}

export const ChoiceCardProps = z.object({
  title: z.string().describe("The question being asked"),
  summary: z
    .string()
    .optional()
    .describe("Any context the person needs to choose"),
  options: z
    .array(
      z.object({
        id: z
          .string()
          .describe("What comes back to you when this one is picked"),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .describe("The options, in the order they should be offered"),
});

type ChoiceArgs = z.infer<typeof ChoiceCardProps>;

export function ChoiceCard(props: Waiting<ChoiceArgs>) {
  const { args, status, respond } = props;
  const [sending, setSending] = useState<string | null>(null);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "正在等待员工…"}>
        <p className="text-sm text-muted-foreground">正在准备问题…</p>
      </GalleryFrame>
    );
  }

  const chosen = status === "complete" ? readChoice(props.result) : undefined;

  return (
    <GalleryFrame
      action={
        chosen ? (
          <Badge tone="positive">已回答</Badge>
        ) : (
          <Badge tone="caution">等你决定</Badge>
        )
      }
      caption={args.summary}
      title={args.title}
    >
      <ul className="space-y-2">
        {(args.options ?? []).map((option) => {
          const picked = chosen === option.id;
          return (
            <li key={option.id}>
              <button
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  picked
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : chosen
                      ? "border-border opacity-50"
                      : "border-border hover:bg-foreground/5"
                }`}
                disabled={Boolean(chosen) || Boolean(sending)}
                onClick={async () => {
                  if (!respond) return;
                  setSending(option.id);
                  await respond({ choice: option.id, label: option.label });
                }}
                type="button"
              >
                <span className="font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </GalleryFrame>
  );
}

/**
 * Read completed answers defensively from the runtime's serialized tool result.
 */
function readResult(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDecision(
  result: string | undefined,
): "approved" | "declined" | undefined {
  const value = readResult(result)?.decision;
  return value === "approved" || value === "declined" ? value : undefined;
}

function readChoice(result: string | undefined): string | undefined {
  const value = readResult(result)?.choice;
  return typeof value === "string" ? value : undefined;
}

/**
 * `kind: "decision"` is what makes these suspend the run: they are registered with
 * `useHumanInTheLoop` rather than as ordinary tools, and the person's answer IS the tool result, so
 * there is no confirmation line to give the model.
 */
export const GALLERY: GalleryComponent[] = [
  {
    name: "askApproval",
    title: "Approval",
    kind: "decision",
    description:
      "Ask the person to approve or decline something, and WAIT for their answer. Use before doing anything you cannot undo, spending money, sending a message, changing a record. You are given their decision and any reason they typed.",
    parameters: ApprovalCardProps,
    Component: ApprovalCard as GalleryComponent["Component"],
    preview: {
      // The whole interaction, because that is what this component is handed: it suspends a run,
      // so its arguments arrive wrapped in the state of the decision it is waiting on.
      status: "executing",
      args: {
        title: "给这笔订单退款吗？",
        summary: "同一笔订单向客户扣了两次款，第二笔还没有结算。",
        details: [
          { label: "金额", value: "$128.40" },
          { label: "客户", value: "北风贸易" },
          { label: "订单", value: "2043" },
        ],
        approveLabel: "退款",
      },
      respond: async () => {},
    },
  },
  {
    name: "askChoice",
    title: "Choice",
    kind: "decision",
    description:
      "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. You are given the id of the option they chose.",
    parameters: ChoiceCardProps,
    Component: ChoiceCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "要发布到哪个环境？",
        summary: "构建已通过，队列里也没有别的任务。",
        options: [
          {
            id: "staging",
            label: "预发环境",
            description: "安全，可回退",
          },
          {
            id: "production",
            label: "生产环境",
            description: "面向真实客户",
          },
        ],
      },
      respond: async () => {},
    },
  },
];
