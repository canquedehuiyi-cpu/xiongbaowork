import type { ReactNode } from "react";
import type { Rail } from "@/lib/navigation";
import { RAIL_LABELS } from "./rail";

/** 设计稿 `.icon-btn`：30px 的圆角方块，细描边。 */
export const iconButtonClassName =
  "grid size-[30px] shrink-0 place-items-center rounded-(--wb-radius-sm) border border-(--wb-line2) bg-(--wb-card) text-(--wb-fg2) outline-none hover:text-(--wb-fg) focus-visible:outline-2 focus-visible:outline-(--wb-accent) [&>svg]:size-4";

/** 设计稿 `.list-head`：列表栏顶上的入口名字，右边可以放按钮。 */
export function ListHead({
  rail,
  children,
}: {
  rail: Rail;
  /** 标题右边的按钮。 */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-2.5">
      <h2 className="m-0 flex-1 font-bold text-(--wb-fg) text-[17px] tracking-[-.01em]">
        {RAIL_LABELS[rail]}
      </h2>
      {children}
    </div>
  );
}
