import { GalleryFrame } from "./frame";

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
/** 原因：员工发来的东西不是组件能画的。 */
export const UNREADABLE = "员工发来的数据读不懂，请让它再试一次。";

/** 原因：调用失败了，但它发来的东西没问题。 */
export const WENT_WRONG = "显示的时候出了问题，请让员工再试一次。";

/**
 * 已经结束、却没留下可画内容的调用：失败了，或者员工发来的东西读不懂。
 *
 * 画在组件的等待状态那里；不然它会一直等永远不会来的数据，重新打开对话也一样。拒绝是另一回事，
 * 有自己的卡片（`RefusedCard`）：那是不允许它显示，这里是它试了但没显示成。
=======
/** Why: what the Bot sent is not something the component can draw. */
export const UNREADABLE =
  "The Bot sent data OpenBot couldn't read. Ask it to try again.";

/** Why, when the call failed and what it sent was fine. */
export const WENT_WRONG =
  "Something went wrong while showing it. Ask the Bot to try again.";

/**
 * A call that is over and left nothing to draw: it failed, or what the Bot sent can't be read.
 *
 * Drawn in place of the component's waiting state, which otherwise waits for data that is never
 * coming, for good and again after a reload. A refusal is something else and has its own card
 * (`RefusedCard`): there the Bot was not allowed to show it, here it tried and couldn't.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
 */
export function FailedCard({
  title,
  reason,
}: {
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  /** 组件自己的标题，不让主人看到工具名。 */
=======
  /** The component's own title, so a person is not shown a tool name. */
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  title: string;
  reason: string;
}) {
  return (
    <GalleryFrame>
      <div data-testid="component-failed" role="status">
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        <p className="text-sm font-medium">没能显示：{title}</p>
=======
        <p className="text-sm font-medium">
          Couldn't show the {title.toLowerCase()}.
        </p>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
        <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
      </div>
    </GalleryFrame>
  );
}
