/**
 * Visible component refusal, using the same blocked-action semantics as computer policy refusals.
 */
export function RefusedCard({
  title,
  reason,
}: {
  /** The component's own title where we know it, so a person is not shown a tool name. */
  title: string;
  reason: string;
}) {
  return (
    <div
      className="my-2 w-full max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="component-refused"
      role="status"
    >
      <p className="text-sm font-medium text-destructive">未显示：{title}</p>
      <p className="mt-1 text-sm text-foreground/80">{reason}</p>
    </div>
  );
}

/** 原因：员工发来的东西不是组件能画的。 */
export const FAILED_UNREADABLE = "员工发来的数据读不懂，请让它再试一次。";

/** 原因：调用失败了，但它发来的东西没问题。 */
export const FAILED_WENT_WRONG = "显示的时候出了问题，请让员工再试一次。";

/**
 * 已经结束、却没留下可画内容的调用：失败了，或者员工发来的东西读不懂。
 *
 * 画在组件的等待状态那里；不然它会一直等永远不会来的数据，重新打开对话也一样。拒绝是另一回事，
 * 有自己的卡片（{@link RefusedCard}）：那是不允许它显示，这里是它试了但没显示成。
 */
export function FailedCard({
  title,
  reason,
}: {
  /** 组件自己的标题，不让主人看到工具名。 */
  title: string;
  reason: string;
}) {
  return (
    <div
      className="my-2 w-full max-w-2xl rounded-xl border px-4 py-3"
      data-testid="component-failed"
      role="status"
    >
      <p className="text-sm font-medium">没能显示：{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
    </div>
  );
}
