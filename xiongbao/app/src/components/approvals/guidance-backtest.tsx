import type { UseMutationResult } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type {
  GuidanceBacktest,
  GuidanceBacktestPreview,
  GuidanceBacktestRow,
} from "@/lib/reviewer-guidance/queries";
import { mediaOf } from "./describe-rules";

/** 「22 个里有 18 个和你的同事判断一致。」 */
export function agreementHeadline(report: GuidanceBacktest): string {
  if (report.reviewed === 0) return "审核一个也没能给出判断。";
  return `${report.reviewed} 个里有 ${report.agreed} 个和你的同事判断一致。`;
}

/** The two ways it disagreed, kept apart: letting through what was denied costs more than asking. */
export function disagreementLine(report: GuidanceBacktest): string {
  return `会放行 ${report.letThroughDenied} 个同事拒绝过的请求，会再问 ${report.askedAllowed} 个同事允许过的请求。`;
}

/** What was replayed and what the reviewer had to go on. */
export function replayedWords(report: GuidanceBacktest): string {
  return [
    `用同事最近处理过的 ${report.sample} 个请求重放了一遍。审核像实际运行时一样读每一个：那段对话里那个人说的话，以及这个动作。`,
    report.withoutRequest > 0
      ? `其中 ${report.withoutRequest} 个没有人说过话，审核只能看动作本身来判断。`
      : null,
    report.skippedSafety > 0
      ? `另有 ${report.skippedSafety} 个由内置安全规则决定，指引改变不了。`
      : null,
    report.unreviewed > 0
      ? `有 ${report.unreviewed} 个审核没能给出判断。`
      : null,
  ]
    .filter(Boolean)
    .join("");
}

const ANSWERS: Record<GuidanceBacktestRow["person"], string> = {
  allow_once: "有人允许了一次。",
  allow_always: "有人选了总是允许。",
  deny: "有人拒绝了。",
};

const WOULD: Record<GuidanceBacktestRow["would"], string> = {
  proceed: "会放行",
  ask: "会先问",
  hand_off: "会交给本人",
  unreviewed: "没有判断",
};

const COLOURS: Record<GuidanceBacktestRow["outcome"], string> = {
  let_through_denied: "text-destructive",
  asked_allowed: "text-amber-600 dark:text-amber-500",
  agree: "text-foreground",
  unreviewed: "text-muted-foreground",
};

/** The request as the approval row the trail keeps for it, so Audit's own cells draw it. */
function auditRowOf(row: GuidanceBacktestRow): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.ownerUserId,
    initiatorKind: row.initiator.kind,
    initiatorId: row.initiator.id,
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: row.toolRef,
    createdAt: row.createdAt,
    payload: {
      bot: row.bot,
      tool: row.toolRef,
      effect: row.effect,
      scope: row.scope,
      ...row.subject,
    },
  };
}

function replayRowOf(row: GuidanceBacktestRow): ReplayRow {
  return {
    id: row.id,
    event: auditRowOf(row),
    media: mediaOf(row.toolRef),
    verdict: WOULD[row.would],
    verdictClassName: COLOURS[row.outcome],
    note: `${ANSWERS[row.person]}${row.reason ? `审核说：「${row.reason}」` : ""}`,
  };
}

/**
 * The reviewer with this guidance, replayed over the requests people decided, when the admin asks.
 * It costs one model call a request, so how many is said on the button and under the label before
 * anything runs. Then: how often it agreed with people, the two ways it didn't, and each request in
 * Audit's own cells, what it would have let through that a person denied first.
 */
export function GuidanceBacktestField({
  preview,
  run,
  text,
}: {
  preview: GuidanceBacktestPreview | undefined;
  run: UseMutationResult<GuidanceBacktest, Error, string>;
  /** The guidance as it stands now. A replay of other words is not shown as this one's. */
  text: string;
}) {
  if (!preview) return null;
  const current = run.data && run.variables === text ? run.data : null;
  const stale = run.data && run.variables !== text;
  /*
   * The results sit beside the field, not in it: a field holding a horizontal row (the replay rows
   * have them) balances its descriptions, which squeezed the lines above the results to half width.
   */
  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      <Field aria-labelledby="guidance-backtest">
        <FieldLabel id="guidance-backtest">拿最近的决定试一试</FieldLabel>
        {preview.calls === 0 ? (
          <FieldDescription>
            同事还没有处理过请求。等他们回答过一些，就可以测试指引了。
          </FieldDescription>
        ) : (
          <>
            <FieldDescription>
              用这段指引，把审核在同事最近处理过的 {preview.calls}{" "}
              个请求上重放一遍。每个请求调用一次模型，共 {preview.calls} 次。
            </FieldDescription>
            <div>
              <Button
                disabled={run.isPending}
                onClick={() => run.mutate(text)}
                size="sm"
                type="button"
                variant="outline"
              >
                {run.isPending
                  ? "正在测试…"
                  : `在 ${preview.calls} 个请求上测试`}
              </Button>
            </div>
          </>
        )}
        {run.error && run.variables === text ? (
          <p className="text-destructive text-sm" role="alert">
            {run.error.message}
          </p>
        ) : null}
        {stale && !run.isPending ? (
          <p className="text-amber-600 text-sm dark:text-amber-500">
            测试之后你改过这段指引。再测一次，看看你的修改会带来什么变化。
          </p>
        ) : null}
      </Field>
      {current ? (
        <div className="flex flex-col gap-3" data-guidance-results>
          <div>
            <p className="font-medium text-sm">{agreementHeadline(current)}</p>
            <p className="mt-0.5 text-sm">{disagreementLine(current)}</p>
            <FieldDescription className="mt-1">
              {replayedWords(current)}
            </FieldDescription>
          </div>
          {current.rows.length > 0 ? (
            <ReplayRows
              rows={current.rows.map(replayRowOf)}
              total={current.rows.length}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
