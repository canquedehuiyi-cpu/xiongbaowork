import { Link } from "@tanstack/react-router";
import type { PluginTeam } from "@/lib/plugins/queries";

/**
 * 资源页「我的」里的一个被给的团队（P4-4b）。
 *
 * 卡片说三件事：这个团叫什么、干什么、几个人；然后给一条进去的路。
 *
 * 这里原先不放入口，理由写在当时：团队的使用入口是频道本身，侧栏已经有了，卡片再放一个按钮只是
 * 重复那条链接。那句话漏了一件事——这一页是「我被给了什么」的清单。技能带档位和理由，连接器带
 * 「去连接」，只有团队是死路：想知道这支团是谁、能干什么，得先回侧栏按名字去翻。清单里列出来的
 * 每一样，都该能从这里走到去用它，重复的是目的地，不是这个人正在找的东西。
 *
 * 落点是 `/channel/$channelId`：一支团是多员工频道，那条路由自己转给群聊，所以卡片既不必分辨团里
 * 几个人，也不必知道群聊住在哪儿。
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
        <div className="flex shrink-0 flex-col items-end gap-[5px]">
          <span
            className="rounded-full border border-border px-[9px] py-[2px] text-[11px] leading-[16px] text-muted-foreground"
            role="status"
          >
            {count} 名员工
          </span>
          {/*
            看得见的是「进入」，读屏念的是「进入软件工坊」：一列卡片里每个链接都叫「进入」，脱离卡片
            就没有意思了。可访问名字包含可见文字，念出来与看到的不打架。
          */}
          <Link
            aria-label={`进入${team.name}`}
            className="text-[11px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
            params={{ channelId: team.id }}
            to="/channel/$channelId"
          >
            进入
          </Link>
        </div>
      </div>
    </li>
  );
}
