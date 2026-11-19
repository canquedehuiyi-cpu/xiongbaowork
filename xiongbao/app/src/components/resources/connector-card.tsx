import type { PluginServer } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * 一个连接器在员工视角下站在哪儿。
 *
 * `settled` 什么都不画——无事发生不需要一个徽章去说：已经连上了，或者本来就不需要凭据（部署内建
 * 的应用），对这个人来说都是「没有你要做的事」。其余三种各自是一句话：`pending` 是「还没连，
 * 你可以去连」（这张卡唯一会画动作的状态），`loading` 与 `unreadable` 是读不到答案时的两种说法，
 * 它们都不许被读成「没连」。
 */
export type ConnectorState = "settled" | "pending" | "loading" | "unreadable";

/**
 * 连接页之外的一个连接器的员工视角。跳转落在 `/connections` 那一页（M5b 起连接器住在那里），
 * 卡片本身就是一行入口，不是详情。
 *
 * 状态由调用方算好传进来：判断「这个人连上没有」要看这个应用是不是以本人身份访问、再读一次连接
 * 列表，那是页面手里的事实，不是这张卡的。
 */
export function ConnectorCard({
  server,
  state,
  action,
}: {
  server: PluginServer;
  state: ConnectorState;
  /** 右侧动作，仅 `pending` 时由调用方给出。缺省只画状态。 */
  action?: React.ReactNode;
}) {
  return (
    <li className="rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
      <div className="flex items-center gap-[10px] px-[13px] py-[11px]">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{server.title}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {server.vendor}
          </p>
        </div>
        {state === "pending" ? (
          <span
            className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-[9px] py-[2px] text-[11px] leading-[16px] text-amber-600 dark:text-amber-400"
            role="status"
          >
            待绑定
          </span>
        ) : null}
        {state === "loading" || state === "unreadable" ? (
          <span
            className="text-[11px] leading-[16px] text-muted-foreground"
            role="status"
          >
            {state === "loading" ? "正在读取你的连接…" : "读不到你的连接"}
          </span>
        ) : null}
        {action ? <div className={cn("shrink-0")}>{action}</div> : null}
      </div>
    </li>
  );
}
