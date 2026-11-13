import type { PluginTeam } from "@/lib/plugins/queries";

/**
 * 资源页「我的」里的一个被给的团队（P4-4b）。
 *
 * 卡片只说三件事：这个团叫什么、干什么、几个人。团队的使用入口是频道本身（侧栏就有），这里
 * 不再放一个「进入团队」按钮去重复侧栏的链接——一个员工被给了什么，这一页只负责列清。
 */
export function TeamCard({ team }: { team: PluginTeam }) {
  const count = team.agentIds.length;
  return (
    <li className="rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] px-[13px] py-[11px]">
      <div className="flex items-start justify-between gap-[9px]">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{team.name}</p>
          <p className="mt-[3px] line-clamp-2 text-[11px] text-muted-foreground">
            {team.description}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full border border-border px-[9px] py-[2px] text-[11px] leading-[16px] text-muted-foreground"
          role="status"
        >
          {count} 名员工
        </span>
      </div>
    </li>
  );
}
