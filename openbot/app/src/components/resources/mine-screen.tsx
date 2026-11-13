import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RunnableBadge } from "@/components/resources/runnable-badge";
import { ConnectorCard } from "@/components/resources/connector-card";
import { TeamCard } from "@/components/resources/team-card";
import { QueryState, TabEmpty } from "@/components/resources/resource-kit";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * 「我的」（`/capabilities/mine`，P4）：一个员工被给了什么的单一列表。
 *
 * 三块共用一次 `/api/plugins` 读，所以失败是这一页自己的告警——技能（每条带移植档位徽章）、
 * 团队（4b：`kind: "team"` 的频道行，品牌包给的专家团）和连接器（没连上的画「待绑定」，跳到
 * `/connections`）。团队块对不下发该字段的老服务端退回空态，不崩。
 */
export function MineScreen() {
  const page = useQuery(pluginsPageQueryOptions());

  const skills = page.data?.skills ?? [];
  const teams = page.data?.teams ?? [];
  const servers = page.data?.servers ?? [];

  return (
    <div className="px-1 pb-6">
      <p className="mt-[4px] text-[13px] text-muted-foreground">
        这个员工被给了什么：技能、团队、连接器。
      </p>

      <section aria-labelledby="mine-skills-head" className="mt-[16px]">
        <h2 id="mine-skills-head" className="text-[15px] font-semibold">
          技能
        </h2>
        <QueryState query={page} label="读不到你的技能">
          {skills.length === 0 ? (
            <TabEmpty
              title="还没有被给的技能"
              description="管理员或品牌包把技能给你的员工后，这里会一条条列出来。"
            />
          ) : (
            <ul
              aria-label="被给的技能"
              className="mt-[9px] grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3"
            >
              {skills.map((skill) => (
                <li
                  key={skill.slug}
                  className="rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] px-[13px] py-[11px]"
                >
                  <div className="flex items-start justify-between gap-[9px]">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">
                        {skill.title}
                      </p>
                      <p className="mt-[3px] line-clamp-2 text-[11px] text-muted-foreground">
                        {skill.summary}
                      </p>
                    </div>
                    <RunnableBadge runnable={skill.runnable} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>

      <section aria-labelledby="mine-teams-head" className="mt-[16px]">
        <h2 id="mine-teams-head" className="text-[15px] font-semibold">
          团队
        </h2>
        <QueryState query={page} label="读不到你的团队">
          {teams.length === 0 ? (
            <TabEmpty
              title="还没有被给的团队"
              description="品牌包把专家团给你后，这里会一支支列出来；团队对话在侧栏里。"
            />
          ) : (
            <ul
              aria-label="被给的团队"
              className="mt-[9px] grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3"
            >
              {teams.map((team) => (
                <TeamCard key={team.id} team={team} />
              ))}
            </ul>
          )}
        </QueryState>
      </section>

      <section aria-labelledby="mine-connectors-head" className="mt-[16px]">
        <h2 id="mine-connectors-head" className="text-[15px] font-semibold">
          连接器
        </h2>
        <QueryState query={page} label="读不到你的连接器">
          {servers.length === 0 ? (
            <TabEmpty
              title="还没有被给的连接器"
              description="品牌包或管理员把连接器加进部署后，这里会一个个列出来。"
            />
          ) : (
            <ul
              aria-label="被给的连接器"
              className="mt-[9px] grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3"
            >
              {servers.map((server) => (
                <ConnectorCard
                  key={server.id}
                  server={server}
                  action={
                    <Link
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      to="/connections"
                    >
                      去连接
                    </Link>
                  }
                />
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
