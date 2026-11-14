import { PRESENCE_WORD, type PresenceStatus } from "@/lib/agents/presence";
import { cn } from "@/lib/utils";

/*
 * 状态点的颜色只从 `--wb-*` 令牌取（`skins/xiongbao/skin.css`）：忙碌橙、空闲绿、已暂停灰。通讯录页和名片
 * 也画在别的皮肤里，那里没有 `--wb-*`，所以每个取值带一个同色的后备。
 */
const DOT_COLOR: Record<Exclude<PresenceStatus, "unknown">, string> = {
  working: "bg-[color:var(--wb-busy,#f5a524)]",
  resting: "bg-[color:var(--wb-idle,#3ccf8e)]",
  paused: "bg-[color:var(--wb-paused,#6b6b74)]",
};

/**
 * 员工的状态点（设计稿 `.ava i`）：忙碌 / 空闲 / 已暂停各一个颜色，读屏读出那个词，所以不只靠颜色认。
 * `unknown`、没拿到（`undefined`）时什么也不画，不画占位。
 *
 * - `overlay`：叠在头像右下角，带一圈底色描边（头像外面要有一个相对定位的祖先）；
 * - `decorative`：旁边已经写着那个词时用，读屏不再念一遍。
 * - `title`：鼠标停上去时多说一句（例如「忙碌 · 正在做的事」）。
 */
export function StatusDot({
  status,
  overlay = false,
  decorative = false,
  title,
  className,
}: {
  status: PresenceStatus | undefined;
  overlay?: boolean;
  decorative?: boolean;
  title?: string;
  className?: string;
}) {
  if (!status || status === "unknown") return null;
  const word = PRESENCE_WORD[status];
  const dotClassName = cn(
    "inline-block size-2 shrink-0 rounded-full",
    overlay &&
      "absolute -right-0.5 -bottom-0.5 size-3 border-2 border-[color:var(--wb-list,var(--background))]",
    DOT_COLOR[status],
    className,
  );
  if (decorative)
    return (
      <span
        aria-hidden="true"
        className={dotClassName}
        data-status-dot={status}
        title={title}
      />
    );
  return (
    <span
      aria-label={word}
      className={dotClassName}
      data-status-dot={status}
      role="img"
      title={title ?? word}
    />
  );
}
