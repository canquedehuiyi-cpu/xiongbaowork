import type { PluginServer } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * 连接页之外的一个连接器的员工视角：一个员工被给了它，但还没把自己的账号（或部署还没把它的
 * 部署凭据）放进来，就画「待绑定」。连上了就不画——无事发生不需要一个徽章去说。
 *
 * 跳转落在 `/connections` 那一页（M5b 起连接器住在那里），卡片本身就是一行入口，不是详情。
 */
export function ConnectorCard({
  server,
  action,
}: {
  server: PluginServer;
  /** 右侧动作，通常是跳到 `/connections` 的链接。缺省只画状态。 */
  action?: React.ReactNode;
}) {
  const pending = !server.hasCredential;
  return (
    <li className="rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
      <div className="flex items-center gap-[10px] px-[13px] py-[11px]">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{server.title}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {server.vendor}
          </p>
        </div>
        {pending ? (
          <span
            className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-[9px] py-[2px] text-[11px] leading-[16px] text-amber-600 dark:text-amber-400"
            role="status"
          >
            待绑定
          </span>
        ) : null}
        {action ? <div className={cn("shrink-0")}>{action}</div> : null}
      </div>
    </li>
  );
}
